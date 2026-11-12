'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Vidu 一键 MV（唱歌/跳舞离线成片）客户端。
 *
 * 官方接口（platform.vidu.cn → Solutions）：
 *   1.0  POST {host}/ent/v2/one-click/mv          基础版
 *   2.0  POST {host}/ent/v2/one-click/premium_mv  增强版（premium_mv_mode: sing/sing_perform/perform/dance）
 *   查询 GET  {host}/ent/v2/tasks/{id}/creations
 * 认证：Authorization: Token {api_key}（与 effects.js 相同的容错处理）。
 *
 * 素材约束（官方 1.0 口径，2.0 除音频时长一致外同源）：
 *   images 1–7 张，png/jpeg/jpg/webp，单张 ≤50MB（Base64 decode 后 ≤10MB）
 *   audio_url 1 个，mp3/wav/aac/m4a，10–300 秒，Base64 decode 后 ≤20MB
 * 2.0 差异：开启 lip_sync 时不支持 540p，且 lip_ref_urls（人脸参考图）必传。
 */

const MV_MODES = ['sing', 'sing_perform', 'perform', 'dance'];
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4' };
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;   // Base64 decode 后上限
const AUDIO_MAX_BYTES = 20 * 1024 * 1024;   // Base64 decode 后上限
const AUDIO_MIN_SECONDS = 10;
const AUDIO_MAX_SECONDS = 300;

/** 纯校验（可单测）：输入不合法时抛出带中文原因的 Error */
function validateMvInput({ images, audio_bytes, duration_s, mode, version, lip_sync, resolution }) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 7) throw new Error('images 须为 1–7 张模特图或风格图');
  if (!Number.isFinite(audio_bytes) || audio_bytes < 1) throw new Error('音频内容缺失');
  if (audio_bytes > AUDIO_MAX_BYTES) throw new Error(`音频解码后 ${(audio_bytes / 1048576).toFixed(1)}MB 超过 20MB 上限`);
  if (!Number.isFinite(duration_s) || duration_s < AUDIO_MIN_SECONDS || duration_s > AUDIO_MAX_SECONDS) {
    throw new Error(`音频时长须在 ${AUDIO_MIN_SECONDS}–${AUDIO_MAX_SECONDS} 秒（官方接口口径）`);
  }
  if (!MV_MODES.includes(mode)) throw new Error(`premium_mv_mode 仅支持：${MV_MODES.join('、')}`);
  if (version === '2.0' && lip_sync && resolution === '540p') throw new Error('开启对口型（lip_sync）时不支持 540p 分辨率');
  return true;
}

function createMvStudio(options = {}) {
  const file = options.file || path.join(options.dataDir || '.', 'mv.json');
  const transport = options.transport || fetch;
  let tasks = [];
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.tasks)) tasks = saved.tasks;
    } catch { /* 损坏文件按空状态重建 */ }
  }
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ tasks: tasks.slice(-50) }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const upsert = task => {
    const index = tasks.findIndex(item => item.task_id === task.task_id);
    if (index >= 0) tasks[index] = { ...tasks[index], ...task };
    else tasks.push(task);
    tasks = tasks.slice(-50);
    persist();
    return tasks.find(item => item.task_id === task.task_id);
  };

  async function request(config, method, resource, body) {
    const key = config.vidu.api_key;
    const response = await transport(`https://${config.vidu.host}${resource}`, {
      method,
      headers: { Authorization: /^(Token|Bearer)\s/i.test(key) ? key : `Token ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120000), redirect: 'error',
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(`Vidu MV 接口 HTTP ${response.status} ${detail.slice(0, 200)}`), { status: 502 });
    }
    return response.json();
  }

  /**
   * 创建 MV 任务。
   * @param {object} input { mode, image_uri, music: {name, buffer(Buffer), duration_s}, version? ('1.0'|'2.0'),
   *                         lip_sync?, lip_ref_urls?, resolution? }
   */
  async function createTask(config, input) {
    if (!config.vidu.api_key) throw new Error('请先配置 Vidu API Key');
    const version = input.version === '1.0' ? '1.0' : '2.0';
    const mode = version === '1.0' ? null : input.mode;
    validateMvInput({
      images: [input.image_uri], audio_bytes: input.music.buffer.length, duration_s: input.music.duration_s,
      mode: mode || 'sing', version, lip_sync: input.lip_sync, resolution: input.resolution,
    });
    const resource = version === '1.0' ? '/ent/v2/one-click/mv' : '/ent/v2/one-click/premium_mv';
    const payload = {
      images: [input.image_uri],
      audio_url: `data:${AUDIO_MIME[path.extname(input.music.name).toLowerCase()] || 'audio/mpeg'};base64,${input.music.buffer.toString('base64')}`,
    };
    if (version === '2.0') {
      payload.premium_mv_mode = input.mode;
      if (input.lip_sync) {
        payload.lip_sync = true;
        if (!Array.isArray(input.lip_ref_urls) || !input.lip_ref_urls.length) throw new Error('开启对口型时 lip_ref_urls（人脸参考图）必传');
        payload.lip_ref_urls = input.lip_ref_urls;
      }
      if (input.resolution) payload.resolution = input.resolution;
    }
    const created = await request(config, 'POST', resource, payload);
    const taskId = String(created.task_id ?? created.id ?? '');
    if (!taskId) throw new Error('MV 接口未返回任务 ID，请到控制台核查是否已创建，勿重复提交');
    return upsert({
      task_id: taskId, mode: mode || 'mv', version, music: input.music.name,
      state: created.state || 'processing', url: '', created_at: new Date().toISOString(),
    });
  }

  async function refreshTask(config, taskId) {
    const known = tasks.find(item => item.task_id === taskId);
    if (!known) throw Object.assign(new Error('MV 任务不存在'), { status: 404 });
    if (known.state === 'success' || known.state === 'failed') return known;
    const data = await request(config, 'GET', `/ent/v2/tasks/${taskId}/creations`);
    const creation = Array.isArray(data.creations) ? data.creations[0] : null;
    const url = creation?.url || creation?.video_url || data.url || '';
    return upsert({ ...known, state: data.state || known.state, url: url || known.url || '' });
  }

  function status() {
    return { modes: MV_MODES, recent: tasks.slice(-10).reverse() };
  }

  return { createTask, refreshTask, status, validateMvInput, MV_MODES };
}

module.exports = { createMvStudio, validateMvInput, MV_MODES, AUDIO_MAX_BYTES, AUDIO_MIN_SECONDS, AUDIO_MAX_SECONDS, crypto };
