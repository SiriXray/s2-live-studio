'use strict';
/**
 * 多供应商 TTS 试听：豆包 HTTP v1 / MiniMax t2a_v2 / Soul tts / 讯飞 WebSocket v2。
 * 统一返回 WAV base64，浏览器可直接播放；不写任何密钥到前端。
 */
const crypto = require('node:crypto');

function wavFromPcm(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function wavBase64(pcm, sampleRate) {
  return wavFromPcm(pcm, sampleRate).toString('base64');
}

async function previewMiniMax(config, voice, text, signal) {
  if (!config.minimax?.api_key) throw Object.assign(new Error('未配置 MiniMax Key'), { status: 503 });
  const response = await fetch('https://api.minimax.cn/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.minimax.api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.minimax.model || 'speech-2.8-turbo',
      text,
      stream: false,
      output_format: 'hex',
      voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 24000, format: 'pcm', channel: 1 },
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.base_resp?.status_code !== 0) {
    throw new Error(payload.base_resp?.status_msg || `MiniMax HTTP ${response.status}`);
  }
  const pcm = Buffer.from(payload.data?.audio || '', 'hex');
  if (!pcm.length) throw new Error('MiniMax 未返回音频');
  return { audio: wavBase64(pcm, 24000), format: 'wav', duration_ms: Math.round(pcm.length / 48), provider: 'minimax', voice };
}

async function previewSoul(config, voice, text, signal) {
  if (!config.soul?.api_key) throw Object.assign(new Error('未配置 Soul Key'), { status: 503 });
  const response = await fetch(`${config.soul.base_url}/api/v1/tts`, {
    method: 'POST',
    headers: { Authorization: config.soul.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.soul.model || 'loxi-speech-1.0',
      text,
      stream: false,
      output_format: 'base64',
      voice_setting: { voice_id: voice },
      audio_setting: { sample_rate: 24000, format: 'pcm', channel: 1 },
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.base_resp?.status_code !== 0) {
    throw new Error(payload.base_resp?.status_msg || `Soul HTTP ${response.status}`);
  }
  const pcm = Buffer.from(payload.data?.audio || '', 'base64');
  if (!pcm.length) throw new Error('Soul 未返回音频');
  return { audio: wavBase64(pcm, 24000), format: 'wav', duration_ms: Math.round(pcm.length / 48), provider: 'soul', voice };
}

async function previewDoubao(config, voice, text, signal) {
  const doubao = config.doubao || {};
  if (!doubao.app_id || !doubao.access_token) throw Object.assign(new Error('未配置豆包 App ID / Access Token'), { status: 503 });
  const response = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer; ${doubao.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      app: { appid: String(doubao.app_id), token: doubao.access_token, cluster: doubao.cluster || 'volcano_tts' },
      user: { uid: 's2-live-voice-lab' },
      audio: { voice_type: voice, encoding: 'pcm', rate: 24000, speed_ratio: 1, volume_ratio: 1, pitch_ratio: 1 },
      request: { reqid: crypto.randomUUID(), text, text_type: 'plain', operation: 'query' },
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.code !== 3000) throw new Error(payload.message || `豆包 HTTP ${response.status} / code ${payload.code}`);
  const pcm = Buffer.from(payload.data || '', 'base64');
  if (!pcm.length) throw new Error('豆包未返回音频');
  return { audio: wavBase64(pcm, 24000), format: 'wav', duration_ms: Math.round(pcm.length / 48), provider: 'doubao', voice };
}

function previewIflytek(config, voice, text, signal) {
  const iflytek = config.iflytek || {};
  if (!iflytek.app_id || !iflytek.api_key || !iflytek.api_secret) {
    return Promise.reject(Object.assign(new Error('未配置讯飞 APPID / APIKey / APISecret'), { status: 503 }));
  }
  if (typeof WebSocket !== 'function') {
    return Promise.reject(Object.assign(new Error('当前 Node 不支持 WebSocket，请升级 Node 22+'), { status: 500 }));
  }
  const host = 'tts-api.xfyun.cn';
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET /v2/tts HTTP/1.1`;
  const signature = crypto.createHmac('sha256', iflytek.api_secret).update(signatureOrigin).digest('base64');
  const authOrigin = `api_key="${iflytek.api_key}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authOrigin).toString('base64');
  const url = `wss://${host}/v2/tts?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => finish(new Error('讯飞合成超时')), 30000);
    const cleanup = () => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(new Error('请求已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        common: { app_id: String(iflytek.app_id) },
        business: { aue: 'raw', auf: 'audio/L16;rate=16000', vcn: voice, tte: 'UTF8' },
        data: { status: 2, text: Buffer.from(text, 'utf8').toString('base64') },
      }));
    });
    ws.addEventListener('message', event => {
      try {
        const payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
        if (payload.code !== 0) return finish(new Error(payload.message || `讯飞 code ${payload.code}`));
        if (payload.data?.audio) chunks.push(Buffer.from(payload.data.audio, 'base64'));
        if (payload.data?.status === 2) {
          const pcm = Buffer.concat(chunks);
          if (!pcm.length) return finish(new Error('讯飞未返回音频'));
          finish(null, { audio: wavBase64(pcm, 16000), format: 'wav', duration_ms: Math.round(pcm.length / 32), provider: 'iflytek', voice });
        }
      } catch (error) { finish(error); }
    });
    ws.addEventListener('error', () => finish(new Error('讯飞 WebSocket 连接失败')));
    ws.addEventListener('close', () => { if (!settled) finish(new Error('讯飞连接提前关闭')); });
  });
}

async function preview(config, { provider, voice, text }, signal) {
  if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new Error('试听文本须为 1–300 字');
  if (!voice) throw new Error('缺少音色 ID');
  if (provider === 'minimax') return previewMiniMax(config, voice, text.trim(), signal);
  if (provider === 'soul') return previewSoul(config, voice, text.trim(), signal);
  if (provider === 'doubao') return previewDoubao(config, voice, text.trim(), signal);
  if (provider === 'iflytek') return previewIflytek(config, voice, text.trim(), signal);
  throw new Error('provider 须为 doubao / minimax / soul / iflytek');
}

module.exports = { preview, wavFromPcm };
