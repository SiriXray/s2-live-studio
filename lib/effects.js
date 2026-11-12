'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

/**
 * PRD-V2 技术能力映射：motion_control_2（才艺舞蹈）与直播特效/MV。
 * 才艺/MV 通过 Vidu 场景模板接口调用：POST {host}/ent/v2/template，Authorization: Token。
 * 直播特效礼物为具名模板（GIFT_FX），各模板 host/画幅/参数不同，按目录逐项覆盖。
 * Motion Sync 驱动跳舞走 image2dance：POST {host}/ent/v2/image2dance。
 * 默认 dry_run（演练模式）：只解析并记录请求，不产生真实生成费用。
 */

/** 通用才艺目录（旧能力，保持兼容） */
const DEFAULT_CATALOG = {
  dance: { template: 'motion_control_2', name: '才艺舞蹈（motion_control_2）', note: '模板选择规则：优先筛选名称含"舞"的模板（如醉酒舞等）；images 传当前主播形象图，避免换人跳舞', aspect_ratio: '9:16' },
  effect: { template: 'motion_control_2', name: 'PK/礼物氛围特效', note: '按礼物档位或PK节点调用不同 template；fx 传 GIFT_FX key 可走具名直播特效模板' },
  mv: { template: 'motion_control_2', name: 'MV 才艺升级', note: '观众点播或高价值礼物触发，与日常舞蹈形成层级差异' },
};

/** 直播特效礼物目录：key → 具名模板参数（用户提供，来自 Vidu 模板中心） */
const GIFT_FX = {
  wizard_of_oz: { key: 'wizard_of_oz', template: 'wizard_of_oz', label: '绿野仙踪', icon: '🌲', host: 'api.vidu.com', aspect_ratio: '1:1', bgm: true, note: '全屏场景特效，适合氛围礼物' },
  angel_wings: { key: 'angel_wings', template: 'Angel_Wings_live', label: '天使之翼', icon: '👼', host: 'api.vidu.com', aspect_ratio: '1:1', bgm: true, note: '主播身上叠加翅膀，适合感谢类礼物' },
  boxing_punch: { key: 'boxing_punch', template: 'Live_boxing_punch', label: 'PK挥拳', icon: '🥊', host: 'api.vidu.cn', aspect_ratio: '9:16', bgm: true, enhance: false, note: '9:16 竖屏 PK 惩罚特效' },
  cream_prank: { key: 'cream_prank', template: 'Live_cream_smearing_prank', label: '扔蛋糕', icon: '🎂', host: 'api.vidu.cn', aspect_ratio: '9:16', bgm: true, enhance: false, note: '9:16 竖屏整蛊特效' },
  mushroom: { key: 'mushroom', template: 'Mushroom', label: '还童蘑菇', icon: '🍄', host: 'api.vidu.com', aspect_ratio: '9:16', bgm: true, note: '吃蘑菇变小孩的整活特效，单人半身最佳，无需 prompt' },
  watermelon_smash: { key: 'watermelon_smash', template: 'Watermelon_smash_to_head', label: '砸西瓜', icon: '🍉', host: 'api.vidu.cn', aspect_ratio: '9:16', bgm: true, enhance: false, note: '头顶砸西瓜整蛊特效，单人半身最佳，无需 prompt' },
};

const DRY_NOTE = '演练模式：未调用真实接口、未产生费用。';

/**
 * 礼物 → 直播特效模板映射（纯函数，便于单测）。
 * 礼物点击后直接在后台走 Vidu 具名模板真实生成，生成完覆盖播放；
 * 即时反馈仍由前端 giftOverlay 图标动效承担（零延迟）。
 * 映射规则：关键词匹配，命中即返回 GIFT_FX key；未命中返回 null（只做前端动效）。
 */
const GIFT_FX_RULES = [
  { keywords: ['拳', 'pk', 'PK'], fx: 'boxing_punch' },
  { keywords: ['蛋糕', '奶油'], fx: 'cream_prank' },
  { keywords: ['蘑菇'], fx: 'mushroom' },
  { keywords: ['西瓜'], fx: 'watermelon_smash' },
  { keywords: ['翼', '翅膀', '天使', '心', '爱心'], fx: 'angel_wings' },
  { keywords: ['仙踪', '森林', '绿野', '灯牌', '火箭', '嘉年华', '城堡'], fx: 'wizard_of_oz' },
];
function mapGiftFx(giftName) {
  const name = String(giftName || '').toLowerCase();
  if (!name) return null;
  const hit = GIFT_FX_RULES.find(rule => rule.keywords.some(word => name.toLowerCase().includes(word.toLowerCase())));
  return hit ? hit.fx : null;
}

/**
 * 构造特效模板请求体（纯函数，便于单测）。
 * @param {object} fx GIFT_FX 中的目录项
 * @param {string} imageUri 主播形象图（data URI 或 URL）
 * @param {object} [overrides] 调用方临时覆盖（aspect_ratio/bgm/enhance/template）
 */
function buildFxPayload(fx, imageUri, overrides = {}) {
  if (!fx || typeof fx.template !== 'string' || !fx.template) throw new Error('特效目录项缺少 template');
  if (typeof imageUri !== 'string' || !imageUri) throw new Error('特效生成需要主播形象图');
  const payload = {
    template: String(overrides.template || fx.template).slice(0, 64),
    images: [imageUri],
    aspect_ratio: ['1:1', '9:16', '16:9'].includes(overrides.aspect_ratio) ? overrides.aspect_ratio : (fx.aspect_ratio || '1:1'),
  };
  const bgm = overrides.bgm !== undefined ? overrides.bgm : fx.bgm;
  const enhance = overrides.enhance !== undefined ? overrides.enhance : fx.enhance;
  if (bgm !== undefined) payload.bgm = Boolean(bgm);
  if (enhance !== undefined) payload.enhance = Boolean(enhance);
  return payload;
}

/**
 * 图生视频请求体（纯函数，便于单测）：Q4 Preview 内测版，model=viduq4-preview，
 * 单张首帧图（URL 或 data URI），时长 3-16s，默认音画同出。
 */
function buildI2vPayload(input = {}) {
  if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('图生视频需要入参图（主播形象图）');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 5000) : '';
  const durationRaw = Number(input.duration);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(16, Math.max(3, Math.round(durationRaw))) : 5;
  const resolution = ['540p', '720p', '1080p', '2K', '4K'].includes(input.resolution) ? input.resolution : '720p';
  return {
    model: 'viduq4-preview',
    images: [input.image_uri],
    duration,
    resolution,
    audio: input.audio === undefined ? true : Boolean(input.audio),
    ...(prompt ? { prompt } : {}),
  };
}

function createEffects(options) {
  const file = options.file || path.join(options.dataDir || '.', 'effects.json');
  const transport = options.transport || fetch;
  const allowLocalFiles = Boolean(options.allowLocalFiles); // 服务端允许引用本机已上传视频（local:// 绝对路径）
  let catalog = structuredClone(DEFAULT_CATALOG);
  let tasks = [];
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.tasks)) tasks = saved.tasks;
      if (saved.catalog && typeof saved.catalog === 'object') catalog = { ...structuredClone(DEFAULT_CATALOG), ...saved.catalog };
    } catch { /* 损坏文件按空状态重建 */ }
  }
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ catalog, tasks: tasks.slice(-100) }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const upsert = task => {
    const index = tasks.findIndex(item => item.task_id === task.task_id);
    if (index >= 0) tasks[index] = { ...tasks[index], ...task };
    else tasks.push(task);
    tasks = tasks.slice(-100);
    persist();
    return tasks.find(item => item.task_id === task.task_id);
  };
  function status() {
    return { catalog, gift_fx: GIFT_FX, dry_run: options.dryRun !== false, recent: tasks.slice(-10).reverse() };
  }
  function setDryRun(value) {
    if (typeof value !== 'boolean') throw new Error('dry_run 须为布尔值');
    options.dryRun = value;
    persist();
    return status();
  }
  async function request(config, method, resource, body, host) {
    const key = config.vidu.api_key;
    const response = await transport(`https://${host || config.vidu.host}${resource}`, {
      method,
      headers: { Authorization: /^(Token|Bearer)\s/i.test(key) ? key : `Token ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(90000), redirect: 'error',
    });
    if (!response.ok) throw Object.assign(new Error(`Vidu接口HTTP ${response.status}；请检查账号权限、模板名与配额`), { status: 502 });
    return response.json();
  }
  /**
   * 创建才艺/特效生成任务。
   * @param {object} input { kind: 'dance'|'effect'|'mv', image_uri, aspect_ratio, template?, fx?,
   *                         real?: true 时忽略 dry_run 强制真实生成（礼物点击直达成片） }
   *   fx 为 GIFT_FX key 时走具名直播特效模板（host/bgm/enhance 按目录覆盖）。
   */
  async function createTask(config, input) {
    const kind = ['dance', 'effect', 'mv'].includes(input.kind) ? input.kind : 'dance';
    const fx = input.fx && GIFT_FX[input.fx] ? GIFT_FX[input.fx] : null;
    const entry = catalog[kind];
    const overrides = {
      aspect_ratio: input.aspect_ratio,
      template: input.template,
      bgm: input.bgm,
      enhance: input.enhance,
    };
    const template = fx ? fx.template : (typeof input.template === 'string' && input.template.trim() ? input.template.trim().slice(0, 64) : entry.template);
    const aspect_ratio = ['9:16', '16:9', '1:1'].includes(input.aspect_ratio) ? input.aspect_ratio : (fx ? fx.aspect_ratio : entry.aspect_ratio);
    if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('才艺/特效生成需要主播形象图');
    const payload = fx
      ? buildFxPayload(fx, input.image_uri, { ...overrides, aspect_ratio })
      : { template, images: [input.image_uri], aspect_ratio };
    const host = fx ? fx.host : undefined;
    if (options.dryRun !== false && input.real !== true) {
      const task = { task_id: `dry-${crypto.randomBytes(4).toString('hex')}`, kind, fx: fx ? fx.key : undefined, state: 'dry_run', payload, host, created_at: new Date().toISOString(), note: `${DRY_NOTE}${fx ? `具名模板 ${fx.template}（${fx.host}）` : '真实模板名以 Vidu 模板中心为准。'}` };
      return upsert(task);
    }
    if (!config.vidu.api_key) throw new Error('请先配置Vidu API Key');
    let created, usedHost = host;
    try {
      created = await request(config, 'POST', '/ent/v2/template', payload, host);
    } catch (error) {
      /* 国际站（api.vidu.com）模板在仅持有国内站 Key 时 401/403：自动回落默认站重试一次 */
      const canFallback = host && host !== config.vidu.host && error.status === 502 && /HTTP (401|403)/.test(error.message);
      if (!canFallback) throw error;
      created = await request(config, 'POST', '/ent/v2/template', payload, config.vidu.host);
      usedHost = config.vidu.host;
    }
    const taskId = String(created.task_id ?? created.id ?? '');
    if (!taskId) throw new Error('模板接口未返回任务ID，请核查控制台是否已创建，勿重复提交');
    return upsert({ task_id: taskId, kind, fx: fx ? fx.key : undefined, state: created.state || 'processing', payload: { template: payload.template, aspect_ratio: payload.aspect_ratio }, host: usedHost, created_at: new Date().toISOString() });
  }
  /**
   * Motion Sync 驱动跳舞：POST /ent/v2/image2dance。
   * 实测（2026-11-04）结论：
   *  1) 形象图/参考视频既可用公网 URL，也可用 Vidu 媒体库引用 `ssupload:?id=...`；
   *  2) ssupload 必须走完整上传三步：POST /tools/v2/files/uploads → PUT 字节(带 x-amz-meta-*) → PUT .../finish {etag}，
   *     缺 finish 一步任务会报 ImageFormatInvalid；
   *  3) 参考视频宽/高需 ≤2048px（1440×2560 直接报 InternalServiceFailure），2-30 秒；
   *  4) 形象图统一走服务端上传转 ssupload（data URI / 公网 URL 均可），保证资产已处理。
   * @param {object} input { image_uri: 人物形象图（data URI 或 URL）, video_url: 公网 URL 或 ssupload 引用 }
   */
  async function createMotionSync(config, input) {
    if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('Motion Sync 需要人物形象图');
    if (typeof input.video_url !== 'string' || !/^(https?:\/\/|data:|ssupload:\?id=|local:\/\/)/i.test(input.video_url)) throw new Error('Motion Sync 需要动作参考视频（公网 URL / 本地上传，2-30 秒、宽高 ≤2048px；超限会自动转码）');
    const brief = value => String(value).slice(0, 48);
    if (options.dryRun !== false) {
      const payload = { image_url: brief(input.image_uri), video_url: brief(input.video_url) };
      return upsert({ task_id: `dry-${crypto.randomBytes(4).toString('hex')}`, kind: 'motion_sync', state: 'dry_run', payload, created_at: new Date().toISOString(), note: `${DRY_NOTE}真实接口 POST /ent/v2/image2dance，约 10 积分/秒。` });
    }
    if (!config.vidu.api_key) throw new Error('请先配置Vidu API Key');
    const imageRef = await resolveImageRef(config, input.image_uri);
    const videoRef = await resolveVideoRef(config, input.video_url);
    const created = await request(config, 'POST', '/ent/v2/image2dance', { image_url: imageRef, video_url: videoRef });
    const taskId = String(created.task_id ?? created.id ?? '');
    if (!taskId) throw new Error('image2dance 未返回任务ID，请核查控制台，勿重复提交');
    return upsert({ task_id: taskId, kind: 'motion_sync', state: created.state || 'processing', created_at: new Date().toISOString() });
  }
  /** 把 data URI / 公网 URL 的形象图统一转为 Vidu 媒体库 ssupload 引用（已 finish 的资产） */
  async function resolveImageRef(config, value) {
    if (/^ssupload:\?id=/i.test(value)) return value;
    let buffer;
    if (/^data:/i.test(value)) {
      const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
      if (!match) throw new Error('形象图 data URI 格式不合法');
      buffer = Buffer.from(match[2], 'base64');
    } else if (/^https?:\/\//i.test(value)) {
      const res = await transport(value, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
      if (!res.ok) throw new Error(`形象图下载失败 HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } else throw new Error('形象图须为 data URI、公网 URL 或 ssupload 引用');
    if (buffer.length > 15 * 1024 * 1024) throw new Error('形象图超过 15MB 上限');
    const dims = imageDims(buffer);
    const id = await uploadMedia(config, { buffer, content_type: mediaType(buffer) || 'image/jpeg', metadata: dims });
    return `ssupload:?id=${id}`;
  }
  /** 参考视频：ssupload 引用直接透传；data URI / 公网 URL 一律下载 → 探测 → 超限转码 → 上传（保证 ≤2048px、20s 内） */
  async function resolveVideoRef(config, value) {
    if (/^ssupload:\?id=/i.test(value)) return value;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 's2video-'));
    try {
      const input = path.join(work, 'input.bin');
      if (/^data:/i.test(value)) {
        const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
        if (!match) throw new Error('参考视频 data URI 格式不合法');
        fs.writeFileSync(input, Buffer.from(match[2], 'base64'));
      } else if (/^local:\/\//i.test(value)) {
        /* 本机已上传视频（服务端 local:// 绝对路径引用），须显式开启 allowLocalFiles */
        if (!allowLocalFiles) throw new Error('本机视频引用未启用');
        const localPath = path.resolve(decodeURIComponent(value.slice('local://'.length)));
        if (!fs.existsSync(localPath)) throw new Error('本机参考视频不存在');
        fs.copyFileSync(localPath, input);
      } else if (/^https?:\/\//i.test(value)) {
        await downloadToFile(value, input);
      } else throw new Error('参考视频须为公网 URL、本地上传、data URI 或 ssupload 引用');
      const info = await (options.probeVideo || probeVideo)(input);
      const plan = videoPlan(info);
      const source = plan.scale < 1 || plan.trim ? await (options.transcodeVideo || transcodeVideo)(input, path.join(work, 'out.mp4'), plan) : input;
      const buffer = fs.readFileSync(source);
      if (buffer.length > 100 * 1024 * 1024) throw new Error('参考视频处理后仍超过 100MB 上限');
      const id = await uploadMedia(config, { buffer, content_type: 'video/mp4', metadata: {} });
      return `ssupload:?id=${id}`;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  /** Vidu 媒体上传三步：create → PUT 字节（带 meta 头，取 ETag）→ PUT finish {etag}。缺 finish 资产不可用 */
  async function uploadMedia(config, { buffer, content_type, metadata = {} }) {
    const created = await request(config, 'POST', '/tools/v2/files/uploads', { metadata: { 'file-size': String(buffer.length), ...metadata }, scene: 'vidu' });
    if (!created.put_url || !created.id) throw new Error('上传接口未返回 put_url/id');
    const metaHeaders = Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k}`, String(v)]));
    const put = await transport(created.put_url, {
      method: 'PUT',
      headers: { 'Content-Type': content_type, 'x-amz-meta-file-size': String(buffer.length), ...metaHeaders },
      body: buffer, signal: AbortSignal.timeout(120000),
    });
    if (!put.ok) throw new Error(`媒体字节上传失败 HTTP ${put.status}`);
    const etag = put.headers?.get ? put.headers.get('etag') : put.headers?.etag;
    if (!etag) throw new Error('字节上传未返回 ETag，无法完成资产确认');
    await request(config, 'PUT', `/tools/v2/files/uploads/${created.id}/finish`, { etag });
    return String(created.id);
  }
  /**
   * 图生视频（Q4 Preview 内测）：POST /ent/v2/img2video，主播形象图作首帧入参图，
   * viduq4-preview 支持音画同出与自动切镜。任务查询复用 refreshTask（同一 creations 接口）。
   * @param {object} input { image_uri, prompt?, duration?(3-16), resolution?, audio?(默认true), real? }
   */
  async function createImg2Video(config, input) {
    const payload = buildI2vPayload(input);
    if (options.dryRun !== false && input.real !== true) {
      return upsert({ task_id: `dry-${crypto.randomBytes(4).toString('hex')}`, kind: 'i2v', state: 'dry_run', payload: { ...payload, images: ['<image>'] }, host: config.vidu.host, created_at: new Date().toISOString(), note: `${DRY_NOTE}真实接口 POST /ent/v2/img2video（viduq4-preview，音画同出）。` });
    }
    if (!config.vidu.api_key) throw new Error('请先配置Vidu API Key');
    const created = await request(config, 'POST', '/ent/v2/img2video', payload);
    const taskId = String(created.task_id ?? created.id ?? '');
    if (!taskId) throw new Error('img2video 未返回任务ID，请核查控制台是否已创建，勿重复提交');
    return upsert({ task_id: taskId, kind: 'i2v', state: created.state || 'processing', created_at: new Date().toISOString(), host: config.vidu.host });
  }
  async function refreshTask(config, taskId) {
    const known = tasks.find(item => item.task_id === taskId);
    if (!known) throw Object.assign(new Error('任务不存在'), { status: 404 });
    if (known.state === 'dry_run' || known.state === 'success' || known.state === 'failed') return known;
    const data = await request(config, 'GET', `/ent/v2/tasks/${taskId}/creations`, undefined, known.host);
    const creation = Array.isArray(data.creations) ? data.creations[0] : null;
    const url = creation?.url || creation?.video_url || data.url || '';
    return upsert({ ...known, state: data.state || known.state, url: url || known.url || '' });
  }
  return { status, setDryRun, createTask, createMotionSync, createImg2Video, refreshTask, uploadMedia, prepareVideo: (config, url) => resolveVideoRef(config, url), DEFAULT_CATALOG };
}

/**
 * 参考视频适配计划（纯函数）：image2dance 要求 2-30 秒、宽高 ≤2048px。
 * 实测 1440×2560 直接报 InternalServiceFailure，故超限一律等比缩到 2048 以内。
 */
function videoPlan({ width, height, duration } = {}) {
  if (!Number.isFinite(duration) || duration < 1.5) throw new Error(`参考视频时长须在 2-30 秒（当前 ${duration ? duration.toFixed(1) : '未知'}s）`);
  const longest = Math.max(Number(width) || 0, Number(height) || 0);
  const scale = longest > 2048 ? 2048 / longest : 1;
  const trim = duration > 30;
  const even = value => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { scale: Number(scale.toFixed(4)), trim, width: even(width || longest), height: even(height || longest) };
}

/** 流式下载到本地文件（上限 200MB，避免大视频占满内存） */
async function downloadToFile(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000), redirect: 'follow' });
  if (!res.ok) throw new Error(`参考视频下载失败 HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 200 * 1024 * 1024) { reader.cancel().catch(() => {}); throw new Error('参考视频超过 200MB 上限'); }
    chunks.push(Buffer.from(value));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

async function probeVideo(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', file], { timeout: 60000 });
    const data = JSON.parse(stdout);
    return { width: Number(data.streams?.[0]?.width) || 0, height: Number(data.streams?.[0]?.height) || 0, duration: Number(data.format?.duration) || 0 };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('服务端未安装 ffmpeg：请先把参考视频处理到宽高 ≤2048px 再上传');
    throw new Error(`参考视频解析失败：${error.message.slice(0, 120)}`);
  }
}

async function transcodeVideo(input, output, plan) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
  if (plan.trim) args.push('-t', '30');
  args.push('-vf', `scale=${plan.width}:${plan.height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', output);
  try {
    await execFileAsync('ffmpeg', args, { timeout: 300000 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('服务端未安装 ffmpeg：请先把参考视频处理到宽高 ≤2048px 再上传');
    throw new Error(`参考视频转码失败：${error.message.slice(0, 120)}`);
  }
  return output;
}

/** 按文件头识别真实 MIME（上传时 Content-Type 必须与实际字节一致，否则 Vidu 侧可能判为格式非法） */function mediaType(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) return 'image/png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return 'video/mp4';
  if (buffer.slice(0, 4).toString('ascii') === '\x1aE\xdf\xa3') return 'video/webm';
  return '';
}

/** 轻量图片尺寸解析（JPEG/PNG/WebP），供上传 metadata 使用；解析不出则返回空对象 */
function imageDims(buffer) {
  try {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) { // PNG
      return { 'image-width': String(buffer.readUInt32BE(16)), 'image-height': String(buffer.readUInt32BE(20)) };
    }
    if (buffer.length > 30 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
      const fourcc = buffer.slice(12, 16).toString('ascii');
      if (fourcc === 'VP8X') {
        return { 'image-width': String(1 + buffer.readUIntLE(24, 3)), 'image-height': String(1 + buffer.readUIntLE(27, 3)) };
      }
      if (fourcc === 'VP8 ') {
        return { 'image-width': String(buffer.readUInt16LE(26) & 0x3fff), 'image-height': String(buffer.readUInt16LE(28) & 0x3fff) };
      }
      if (fourcc === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { 'image-width': String((bits & 0x3fff) + 1), 'image-height': String(((bits >> 14) & 0x3fff) + 1) };
      }
    }
    // JPEG：扫 SOF0-SOF3 段
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buffer.length) {
        if (buffer[off] !== 0xff) { off += 1; continue; }
        const marker = buffer[off + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { 'image-height': String(buffer.readUInt16BE(off + 5)), 'image-width': String(buffer.readUInt16BE(off + 7)) };
        }
        off += 2 + buffer.readUInt16BE(off + 2);
      }
    }
  } catch { /* 尺寸仅是辅助 metadata，解析失败不阻塞上传 */ }
  return {};
}

module.exports = { createEffects, DEFAULT_CATALOG, GIFT_FX, GIFT_FX_RULES, mapGiftFx, buildFxPayload, buildI2vPayload, videoPlan };
