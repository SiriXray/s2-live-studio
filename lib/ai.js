'use strict';

/**
 * MiniMax speech-2.8 系列拟声标签（文本内联，T2A 时替换中文语气词为真实笑声/叹气等非语言声音）：
 * (laughs)笑声 (chuckle)轻笑 (sighs)叹气 (breath)换气 (emm)嗯 (gasps)倒吸气 (humming)哼唱 等 19 个。
 * Soul（Loxinity）不认这些标签 → 送 Soul 前须 stripSoundTags 清洗；送 S2 的口播字幕文本同样用清洗版。
 */
const SOUND_TAG_RE = /\((laughs|chuckle|coughs|clear-throat|clears throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|applause|humming|hissing|emm|sneezes)\)/g;

/** 中文语气词 → MiniMax 拟声标签映射（先大笑后轻笑/叹气；叠词整体归一） */
const FILLER_TO_TAG = [
  [/(哈{3,}|哈哈哈+)/g, '(laughs)'],
  [/(哈{2}|嘿嘿+|嘻嘻+|呵呵+)/g, '(chuckle)'],
  [/(嗯{2,}|嗯+[。．.，,]?)/g, '(emm)'],
  [/([唉哎]+[—…～。]?)|(叹气)/g, '(sighs)'],
];

/** 把中文语气词替换为 MiniMax 拟声标签（仅 2.8 系列模型；句首语气词+标点整体替换为「标签 + 短停顿」） */
function applySoundTags(text, model) {
  if (!text || !/^speech-2\.8/.test(String(model || ''))) return text;
  let out = text;
  for (const [pattern, tag] of FILLER_TO_TAG) out = out.replace(pattern, tag);
  // 标签后紧跟的逗号/顿号没有意义，去掉；相邻同类标签去重
  out = out.replace(/\((laughs|chuckle|sighs|emm|breath|gasps)\)[，,、]?/g, '($1)');
  out = out.replace(/\((laughs|chuckle)\)\s*\((laughs|chuckle)\)/g, '($1)');
  return out;
}

/** 清除拟声标签（S2 口播字幕用），标签位置补一个逗号，避免字幕粘连 */
function stripSoundTags(text) {
  if (!text) return text;
  return String(text)
    .replace(SOUND_TAG_RE, '，')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/，{2,}/g, '，')
    .replace(/([，。！？；：])\1+/g, '$1')
    .replace(/^[，。！？；：\s]+|[，。！？；：\s]+$/g, '')
    .trim();
}

/**
 * 把 MiniMax 拟声标签转成 Soul / 通用 TTS 可读的口语填充词。
 * 目的不是“删掉标签”，而是让不支持标签的供应商也保留笑声、叹气、换气与思考停顿。
 */
function soundTagsToFillers(text) {
  if (!text) return text;
  return String(text)
    .replace(/\(laughs\)/gi, '哈哈，')
    .replace(/\(chuckle\)/gi, '嘿嘿，')
    .replace(/\(sighs\)/gi, '唉……')
    .replace(/\(emm\)/gi, '嗯，')
    .replace(/\(breath\)/gi, '……')
    .replace(/\(gasps\)/gi, '啊，')
    .replace(/\(coughs\)/gi, '咳，')
    .replace(/\(clear-throat\)/gi, '咳，')
    .replace(/\(sniffs\)/gi, '……')
    .replace(SOUND_TAG_RE, '')
    .replace(/([^，。！？；：\s])(哈哈，|嘿嘿，|唉……|嗯，|啊，)/g, '$1，$2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([，。！？；：])\1+/g, '$1')
    .trim();
}

async function requestJson(url, key, body, signal, transport = fetch) {
  const response = await transport(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} 返回 HTTP ${response.status}，请检查凭据、模型权限及余额`);
  return response.json();
}

function validateTurn(input) {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new Error('请输入1至2000字的问题');
  if (!Array.isArray(input.history || []) || (input.history || []).length > 20) throw new Error('最多保留20条历史消息');
  const history = (input.history || []).map(message => {
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 2000) throw new Error('历史消息格式不正确');
    return { role: message.role, content: message.content };
  });
  return { text: input.text.trim(), history };
}

async function reply(config, input, signal, transport) {
  const turn = validateTurn(input);
  if (!config.llm.api_key) throw new Error('请在连接设置中填写 LLM（Vidu recaption）API Key');
  const response = await requestJson(`${config.llm.base_url}/chat/completions`, config.llm.api_key, {
    model: config.llm.model,
    messages: [{ role: 'system', content: config.live.persona }, ...turn.history, { role: 'user', content: turn.text }],
    stream: false,
    thinking: { type: 'enabled', level: 'low' },
    max_tokens: 1600,
  }, signal, transport);
  const text = response.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${config.llm.model} 没有返回可播报的文本`);
  if (text.length > 2000) throw new Error('回复过长，请缩短主持人人设中的回复长度');
  return text.trim();
}

async function synthesize(config, text, signal, transport) {
  if (!config.minimax.api_key) throw new Error('请在连接设置中填写 MiniMax API Key');
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('试听文本须为1至2000字');
    const response = await requestJson('https://api.minimax.cn/v1/t2a_v2', config.minimax.api_key, {
    model: config.minimax.model,
    text: applySoundTags(text, config.minimax.model),
    stream: false,
    output_format: 'hex',
    voice_setting: { voice_id: config.minimax.voice_id, speed: config.minimax.speed, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 24000, format: 'pcm', channel: 1 },
  }, signal, transport);
  if (response.base_resp?.status_code !== 0) throw new Error(`MiniMax合成失败，业务码 ${response.base_resp?.status_code ?? '缺失'}`);
  const hex = response.data?.audio;
  if (typeof hex !== 'string' || !hex.length || hex.length % 4 !== 0 || !/^[a-f\d]+$/i.test(hex)) throw new Error('MiniMax未返回有效的PCM16音频');
  const info = response.extra_info || {};
  if ((info.audio_sample_rate && info.audio_sample_rate !== 24000) || (info.audio_channel && info.audio_channel !== 1) || (info.audio_format && info.audio_format !== 'pcm')) throw new Error('MiniMax返回的音频格式不符合24kHz单声道PCM要求');
  const pcm = Buffer.from(hex, 'hex');
  if (pcm.length > 24000 * 2 * 90) throw new Error('单次语音超过90秒，请缩短回复');
  if (['RIFF', 'ID3'].includes(pcm.toString('ascii', 0, 4)) || pcm.toString('ascii', 0, 3) === 'ID3') throw new Error('音频包含文件头，无法作为裸PCM发送');
  return { audio: pcm.toString('base64'), format: 'pcm_s16le_24000_mono', duration_ms: pcm.length / 48, provider: 'minimax' };
}

/** Soul（Loxinity）对话式语音合成：POST {base_url}/api/v1/tts，返回 24kHz 单声道 PCM base64 */
async function synthesizeSoul(config, text, signal, transport = fetch) {
  if (!config.soul.api_key) throw new Error('请在连接设置中填写 Soul API Key');
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('试听文本须为1至2000字');
  if (!config.soul.voice_id) throw new Error('请先在连接设置中填写 Soul 音色 ID');
  // Loxinity 要求 Authorization 直传 API Key（API_KEY scheme），不能加 Bearer 前缀
  const response = await transport(`${config.soul.base_url}/api/v1/tts`, {
    method: 'POST',
    headers: { Authorization: config.soul.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.soul.model,
      text: soundTagsToFillers(text),
      stream: false,
      output_format: 'base64',
      voice_setting: { voice_id: config.soul.voice_id },
      audio_setting: { sample_rate: 24000, format: 'pcm', channel: 1 },
    }),
    signal: AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`${new URL(response.url || 'https://api.loxinity.com').hostname} 返回 HTTP ${response.status}，请检查 Soul Key 与权限`);
  const payload = await response.json();
  if (payload.base_resp?.status_code !== 0) throw new Error(`Soul合成失败，业务码 ${payload.base_resp?.status_code ?? '缺失'}`);
  const audio = payload.data?.audio;
  if (typeof audio !== 'string' || !audio.length) throw new Error('Soul未返回有效音频');
  const pcm = Buffer.from(audio, 'base64');
  if (pcm.length > 24000 * 2 * 90) throw new Error('单次语音超过90秒，请缩短回复');
  if (['RIFF', 'ID3'].includes(pcm.toString('ascii', 0, 4))) throw new Error('Soul返回的音频包含文件头，无法作为裸PCM发送');
  return { audio: audio, format: 'pcm_s16le_24000_mono', duration_ms: Math.round((payload.data?.duration || pcm.length / 48) * 1000), provider: 'soul' };
}

/** 主备合成：Soul 可用且配置了音色时优先 Soul，失败自动回落 MiniMax；否则仅 MiniMax */
async function synthesizeWithFallback(config, text, signal, transport) {
  const soulReady = Boolean(config.soul?.api_key && config.soul?.voice_id);
  if (!soulReady) return synthesize(config, text, signal, transport);
  try {
    return await synthesizeSoul(config, text, signal, transport);
  } catch (soulError) {
    try {
      const audio = await synthesize(config, text, signal, transport);
      return { ...audio, fallback_from: 'soul', fallback_reason: soulError.message };
    } catch (minimaxError) {
      throw new Error(`Soul与MiniMax合成均失败：Soul[${soulError.message}] MiniMax[${minimaxError.message}]`);
    }
  }
}

module.exports = { reply, synthesize, synthesizeSoul, synthesizeWithFallback, validateTurn, requestJson, applySoundTags, stripSoundTags, soundTagsToFillers };
