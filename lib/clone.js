'use strict';

/**
 * 音色克隆适配层：Soul（Loxinity）/ MiniMax / Qwen（DashScope）三家统一入口。
 *
 * 设计要点：
 * - 三家返回统一结构：{ provider, voice_id, demo: {audio(base64 wav), duration_ms} | null, raw }
 * - Soul：POST /api/v1/voice_clone，file_base64 + file_format（mp3/wav/m4a），可选 voice_id/text/model，
 *   自带试听 demo_audio（base64 wav）；克隆槽位上限 3，满了会报错。
 * - MiniMax：POST /v1/files/upload（multipart, purpose=voice_clone）拿 file_id →
 *   POST /v1/voice_clone（file_id + 自定义 voice_id + model）→ 用 t2a_v2 合成一段试听。
 * - Qwen：POST dashscope /api/v1/services/audio/tts/customization（model=voice-enrollment,
 *   action=create_voice, target_model=qwen-audio-3.1-tts-flash, audio 为 data URI）→
 *   轮询 query_voice 到 OK → SpeechSynthesizer 合成试听（返回音频 URL，转投 base64）。
 * - 输入统一为 audio: Buffer（wav/mp3/m4a 原始文件字节）+ format。Qwen 要求 data URI；
 *   Soul 直接 base64 字符串；MiniMax 走 multipart 文件上传。
 */

const CLONE_TIMEOUT_MS = 120000;

function b64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

/** 从音频字节推断格式（wav/mp3/m4a） */
function sniffFormat(buffer, fallback = 'wav') {
  const head = Buffer.from(buffer).subarray(0, 12);
  if (head.subarray(0, 4).toString('ascii') === 'RIFF') return 'wav';
  if (head.subarray(0, 3).toString('ascii') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'mp3';
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  return fallback;
}

const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4' };

/** Soul 克隆：返回 voice_id + 自带试听 demo_audio（base64 wav） */
async function cloneSoul(config, { audio, format, voiceId, text, noiseReduction = false, dereverberation = false, volumeNormalization = false, signal, transport = fetch }) {
  if (!config.soul?.api_key) throw new Error('请在连接设置中填写 Soul API Key');
  if (!config.soul?.base_url) throw new Error('Soul base_url 缺失');
  const body = {
    file_base64: b64(audio),
    file_format: format || sniffFormat(audio),
    need_noise_reduction: Boolean(noiseReduction),
    need_dereverberation: Boolean(dereverberation),
    need_volume_normalization: Boolean(volumeNormalization),
  };
  if (voiceId) body.voice_id = String(voiceId).slice(0, 64);
  if (text && String(text).trim()) {
    body.text = String(text).trim().slice(0, 900);
    body.model = config.soul.model || 'loxi-speech-1.0';
  }
  const response = await transport(`${config.soul.base_url}/api/v1/voice_clone`, {
    method: 'POST',
    headers: { Authorization: config.soul.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(CLONE_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => null);
  if (payload?.base_resp?.status_code !== 0) {
    const msg = payload?.base_resp?.status_msg || `HTTP ${response.status}`;
    throw new Error(`Soul 克隆失败：${msg}${payload?.base_resp?.status_code === 2013 ? '（检查音频格式/大小，或克隆槽位已满，可在 Loxinity 控制台删除旧音色）' : ''}`);
  }
  const voiceId2 = payload.data?.voice_id || voiceId || '';
  if (!voiceId2) throw new Error('Soul 克隆成功但未返回 voice_id');
  // demo_audio 两种形态：base64 字符串（直接用）或 {url, duration}（m4a 链接，服务端代下载转 base64）
  let demo = null;
  const rawDemo = payload.data?.demo_audio;
  if (typeof rawDemo === 'string' && rawDemo) {
    demo = { audio: rawDemo, duration_ms: null };
  } else if (rawDemo && typeof rawDemo.url === 'string') {
    try {
      const audioResponse = await transport(rawDemo.url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
      if (audioResponse.ok) {
        const bytes = Buffer.from(await audioResponse.arrayBuffer());
        demo = { audio: bytes.toString('base64'), duration_ms: rawDemo.duration ? Math.round(rawDemo.duration * 1000) : null, mime: rawDemo.url.match(/\.(\w+)(\?|$)/)?.[1] || 'm4a' };
      }
    } catch { /* demo 下载失败不影响克隆结果 */ }
  }
  return { provider: 'soul', voice_id: voiceId2, demo, raw: { status: payload.base_resp.status_code } };
}

/** MiniMax 上传：multipart purpose=voice_clone → file_id */
async function minimaxUpload(key, audio, format, signal, transport) {
  const boundary = `----s2clone${Date.now()}`;
  const bytes = Buffer.from(audio);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nvoice_clone\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clone.${format || sniffFormat(audio)}"\r\nContent-Type: ${MIME[format || sniffFormat(audio)] || 'application/octet-stream'}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await transport('https://api.minimax.cn/v1/files/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.any([AbortSignal.timeout(CLONE_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`MiniMax 上传失败：HTTP ${response.status}`);
  const payload = await response.json();
  const fileId = payload?.file?.file_id;
  if (!fileId) throw new Error(`MiniMax 上传失败：${payload?.base_resp?.status_msg || '未返回 file_id'}`);
  return fileId;
}

/** 判断 MiniMax 返回的 PCM hex 是否真的有人声；刚克隆的音色偶尔会先返回一段全零静音 */
function pcmHasSignal(hex) {
  if (!hex || typeof hex !== 'string') return false;
  const buffer = Buffer.from(hex, 'hex');
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    if (buffer[index] !== 0 || buffer[index + 1] !== 0) return true;
  }
  return false;
}

/** MiniMax 克隆：上传 → voice_clone → t2a_v2 试听合成 */
async function cloneMiniMax(config, { audio, format, voiceId, text, noiseReduction = false, volumeNormalization = false, signal, transport = fetch }) {
  if (!config.minimax?.api_key) throw new Error('请在连接设置中填写 MiniMax API Key');
  if (!voiceId || !/^[a-zA-Z0-9_\-]{1,64}$/.test(voiceId)) throw new Error('MiniMax 克隆需要自定义 voice_id（字母数字下划线，≤64 字符）');
  const fmt = format || sniffFormat(audio);
  const fileId = await minimaxUpload(config.minimax.api_key, audio, fmt, signal, transport);
  const cloneResponse = await transport('https://api.minimax.cn/v1/voice_clone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.minimax.api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: Number(fileId),
      voice_id: voiceId,
      model: config.minimax.model || 'speech-2.8-turbo',
      need_noise_reduction: Boolean(noiseReduction),
      need_volume_normalization: Boolean(volumeNormalization),
    }),
    signal: AbortSignal.any([AbortSignal.timeout(CLONE_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    redirect: 'error',
  });
  const clonePayload = await cloneResponse.json().catch(() => null);
  if (clonePayload?.base_resp?.status_code !== 0) {
    const msg = clonePayload?.base_resp?.status_msg || `HTTP ${cloneResponse.status}`;
    const friendly = /duration too short/i.test(msg) ? '（参考音频太短，MiniMax 要求至少 10 秒）' : '';
    throw new Error(`MiniMax 克隆失败：${msg}${friendly}`);
  }
  // 用克隆音色合成一段试听（与 t2a_v2 同链路）
  let demo = null;
  const demoText = (text && String(text).trim()) || '大家好，这是我的克隆声音，欢迎来到直播间。';
  try {
    const ttsResponse = await transport('https://api.minimax.cn/v1/t2a_v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.minimax.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.minimax.model || 'speech-2.8-turbo',
        text: demoText.slice(0, 900),
        stream: false,
        output_format: 'hex',
        voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 24000, format: 'pcm', channel: 1 },
      }),
      signal: AbortSignal.any([AbortSignal.timeout(CLONE_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      redirect: 'error',
    });
    const ttsPayload = await ttsResponse.json();
    if (ttsPayload.base_resp?.status_code === 0 && ttsPayload.data?.audio && pcmHasSignal(ttsPayload.data.audio)) {
      demo = { audio: Buffer.from(ttsPayload.data.audio, 'hex').toString('base64'), duration_ms: Math.round((ttsPayload.data?.audio?.length || 0) / 2 / 48) };
    }
  } catch { /* 试听失败不影响克隆结果 */ }
  return { provider: 'minimax', voice_id: voiceId, demo, raw: { file_id: fileId } };
}

/** Qwen（DashScope）克隆：voice-enrollment create_voice → 轮询 OK → SpeechSynthesizer 试听 */
async function cloneQwen(config, { audio, format, voiceId, text, signal, transport = fetch }) {
  if (!config.vlm?.api_key) throw new Error('请在连接设置中填写 VLM（DashScope）API Key');
  const fmt = format || sniffFormat(audio);
  const targetModel = 'qwen-audio-3.1-tts-flash';
  const dataUri = `data:${MIME[fmt] || 'audio/wav'};base64,${b64(audio)}`;
  const base = 'https://dashscope.aliyuncs.com/api/v1';
  const post = async (path, body) => {
    const response = await transport(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.vlm.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`DashScope 返回 HTTP ${response.status}，请检查 VLM Key 与权限`);
    return response.json();
  };
  const createBody = {
    model: 'voice-enrollment',
    input: {
      action: 'create_voice',
      target_model: targetModel,
      audio: dataUri,
      ...(voiceId ? { prefix: String(voiceId).replace(/[^0-9a-z]/g, '').slice(0, 10) || 's2clone' } : { prefix: 's2clone' }),
    },
  };
  const created = await post('/services/audio/tts/customization', createBody);
  const voiceId2 = created?.output?.voice_id;
  if (!voiceId2) throw new Error(`Qwen 克隆失败：${created?.message || '未返回 voice_id'}`);
  // 轮询状态（最长 ~60s）
  let status = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const queried = await post('/services/audio/tts/customization', { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: voiceId2 } });
    status = queried?.output?.status || '';
    if (status === 'OK') break;
    if (status && status !== 'DEPLOYING') throw new Error(`Qwen 克隆音色状态异常：${status}`);
  }
  if (status !== 'OK') throw new Error('Qwen 克隆音色部署超时，请稍后在音色列表中查询');
  // 试听合成
  let demo = null;
  const demoText = (text && String(text).trim()) || '大家好，这是我的克隆声音，欢迎来到直播间。';
  try {
    const synthesized = await post('/services/audio/tts/SpeechSynthesizer', {
      model: targetModel,
      input: { text: demoText.slice(0, 900), voice: voiceId2, format: 'wav', sample_rate: 24000 },
    });
    const audioUrl = synthesized?.output?.audio?.url;
    if (audioUrl) {
      const audioResponse = await transport(audioUrl, { signal: AbortSignal.timeout(60000), redirect: 'error' });
      if (audioResponse.ok) {
        const wav = Buffer.from(await audioResponse.arrayBuffer());
        demo = { audio: wav.toString('base64'), duration_ms: null };
      }
    }
  } catch { /* 试听失败不影响克隆结果 */ }
  return { provider: 'qwen', voice_id: voiceId2, demo, raw: { target_model: targetModel, status } };
}

/** 统一入口 */
async function cloneVoice(config, input) {
  const provider = String(input.provider || '').toLowerCase();
  if (provider === 'soul') return cloneSoul(config, input);
  if (provider === 'minimax') return cloneMiniMax(config, input);
  if (provider === 'qwen') return cloneQwen(config, input);
  throw new Error('不支持的克隆提供商（soul / minimax / qwen）');
}

module.exports = { cloneVoice, cloneSoul, cloneMiniMax, cloneQwen, sniffFormat, CLONE_TIMEOUT_MS };
