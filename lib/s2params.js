'use strict';
/**
 * S2 组件版（/live/s_avatar/component）参数模型。
 *
 * 组件版创建会话只接受：model / resolution / image_uri|avatar_id /
 * persona / action{enabled,library_id} / customer_rtc|managed_rtc。
 * 官方没有 action_prompt、idle_motion、vad、llm、singing.ducking 等创建字段；
 * 本文件里的唱跳/转场/idle 只是本站应用层时序，不发送给 Vidu。
 */
const RESOLUTIONS = ['720p', '1080p', '2k'];
const IDLE_MIN = 0;
const IDLE_MAX = 60;
const REST_MIN = 1;
const REST_MAX = 60;

const DEFAULTS = Object.freeze({
  model: 'vidu-s2',
  resolution: '720p',
  action: { enabled: true, library_id: '0' },
  action_prompt: '',
  naturalness: {
    transition: { baseline_reset: true, videos: [], hold_ms: 400, auto_from_recent: true },
    singing: { suppress_idle: true, tail_pad_ms: 600, ducking: 0.35 },
    dance: { segment_seconds: 2, bridge_action: true, bridge_text: '面向镜头微笑' },
    idle: { interval_s: 0, rest_s: 0 },
  },
});

const PRESETS = Object.freeze({
  speech: {
    label: '稳健口播',
    hint: '动作最少、最稳，适合带货/念稿；转场必开 baseline_reset，避免换形象时残留旧姿势。',
    value: {
      resolution: '720p',
      action: { enabled: true, library_id: '0' },
      action_prompt: '动作幅度小，以手势和轻微点头为主，说话时保持正面朝向镜头，避免遮挡面部',
      naturalness: {
        transition: { baseline_reset: true, videos: [], hold_ms: 400, auto_from_recent: true },
        singing: { suppress_idle: true, tail_pad_ms: 600, ducking: 0.35 },
        dance: { segment_seconds: 2, bridge_action: true, bridge_text: '面向镜头微笑' },
        idle: { interval_s: 14, rest_s: 5 },
      },
    },
  },
  natural: {
    label: '自然互动',
    hint: '默认推荐：中等幅度动作 + 10s 静默微动作，兼顾自然度与画面稳定。',
    value: {
      resolution: '720p',
      action: { enabled: true, library_id: '0' },
      action_prompt: '像真人主播一样自然：说话时配合手势，偶尔侧身与视线偏移，动作有起势和收势，不做夸张定格',
      naturalness: {
        transition: { baseline_reset: true, videos: [], hold_ms: 600, auto_from_recent: true },
        singing: { suppress_idle: true, tail_pad_ms: 800, ducking: 0.35 },
        dance: { segment_seconds: 2, bridge_action: true, bridge_text: '面向镜头微笑' },
        idle: { interval_s: 10, rest_s: 3 },
      },
    },
  },
  stage: {
    label: '舞台唱跳',
    hint: '唱跳优先：1080p、动作幅度大、静默间隔短；转场用最近一次 MV/舞蹈成片做过渡视频。',
    value: {
      resolution: '1080p',
      action: { enabled: true, library_id: '0' },
      action_prompt: '舞台表演状态：动作幅度大、有节奏感，演唱时手部随节拍摆动，舞蹈段落衔接流畅不突兀',
      naturalness: {
        transition: { baseline_reset: true, videos: [], hold_ms: 800, auto_from_recent: true },
        singing: { suppress_idle: true, tail_pad_ms: 1000, ducking: 0.25 },
        dance: { segment_seconds: 1.5, bridge_action: true, bridge_text: '面向镜头微笑' },
        idle: { interval_s: 6, rest_s: 2 },
      },
    },
  },
});

const GUIDANCE = [
  { key: 'resolution', label: '会话分辨率', note: '720p 足够直播且最省算力；1080p/2k 仅在合唱、唱跳特写时值得开，创建后不可热改。' },
  { key: 'action.enabled', label: '运行时动作匹配', note: '关闭后数字人只做口型与静默微动作；口播类场景建议保持开启。' },
  { key: 'action.library_id', label: '动作库', note: '"0" 为平台默认库；自建库需先在 Vidu 侧建好并归属本账号，否则创建会话直接 400/403。' },
  { key: 'action_prompt', label: '动作特色提示词', note: '影响所有动作的执行风格，是「唱/跳不僵硬」最省力的旋钮：写幅度、起收势、视线与朝向，不写具体剧情。' },
  { key: 'transition.baseline_reset', label: '转场前复位', note: '换形象/换造型前先发 type=15 baseline_reset，把画面复位到闭口静息态，再播转场视频，可消除换人瞬间的残留姿势与黑帧违和感。' },
  { key: 'transition.videos', label: '转场视频', note: 'type=16 的 switch_videos：1–10 个 http(s) 视频，按顺序完整播一轮后新形象才生效；单条 ≤30 分钟、累计 ≤60 分钟。没有视频时平台会直接切画面，容易出现黑帧。' },
  { key: 'transition.hold_ms', label: '转场驻留', note: '转场视频播完到恢复互动之间的留白，给新形象一个「亮相」的缓冲；建议 400–800ms。' },
  { key: 'singing.suppress_idle', label: '演唱期禁小动作', note: '开唱后停发 type=9，避免手脚动作抢走口型驱动，画面更贴唱。' },
  { key: 'singing.ducking', label: '伴奏压低比例', note: '人声与伴奏同轨时给伴奏留的余量，0.25–0.4 较自然。' },
  { key: 'singing.tail_pad_ms', label: '唱后收尾', note: '最后一句唱完到恢复互动之间的缓冲，防止「唱完立刻接话」的抢拍。' },
  { key: 'dance.segment_seconds', label: '舞蹈分段', note: 'type=9 单条动作 1–2s 最稳；2s 最自然，1.5s 更适合快节奏。' },
  { key: 'dance.bridge_action', label: '段间过渡动作', note: '每段之间插一个收势动作（如「面向镜头微笑」），避免连续硬切造成抽帧感。' },
  { key: 'idle.interval_s', label: '静默微动作间隔', note: '对应本站 triggers.idle_motion_s（5–60s）：太短像抽动，太长像卡住，10–14s 最像真人。' },
  { key: 'idle.rest_s', label: '动作后回落', note: '每个微动作之后回落静止的秒数，1–5s 让动作有起收势。' },
];

function preset(name) {
  const hit = PRESETS[name];
  if (!hit) throw new Error(`未知预设：${name}`);
  return normalize(clone(hit.value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} 必须是 ${min}–${max} 之间的数字`);
  }
  return parsed;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
  return value;
}

function text(value, label, max) {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${label} 最多 ${max} 个字符`);
  return trimmed;
}

/** 深合并到默认值之上，并对已知字段做范围校验。input 必须是对象。 */
function normalize(input, base = DEFAULTS) {
  if (!isPlainObject(input)) throw new Error('S2 参数必须是对象');
  const merged = clone(base);
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(merged, key)) throw new Error(`未知的 S2 参数：${key}`);
    if (isPlainObject(merged[key])) {
      merged[key] = normalizeKnown(merged[key], value, key);
    } else {
      merged[key] = value;
    }
  }
  validate(merged);
  return merged;
}

function normalizeKnown(base, value, prefix) {
  if (!isPlainObject(value)) throw new Error(`${prefix} 必须是对象`);
  const result = clone(base);
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(result, key)) throw new Error(`未知的 S2 参数：${prefix}.${key}`);
    if (isPlainObject(result[key])) result[key] = normalizeKnown(result[key], item, `${prefix}.${key}`);
    else result[key] = item;
  }
  return result;
}

function validate(config) {
  if (!['vidu-s2', 'vidu-s1'].includes(config.model)) throw new Error('model 仅支持 vidu-s2 / vidu-s1');
  if (!RESOLUTIONS.includes(config.resolution)) throw new Error(`resolution 仅支持：${RESOLUTIONS.join('、')}`);
  config.action.enabled = bool(config.action.enabled, 'action.enabled');
  config.action.library_id = text(String(config.action.library_id ?? '0'), 'action.library_id', 64) || '0';
  config.action_prompt = text(config.action_prompt || '', 'action_prompt', 500);

  const t = config.naturalness.transition;
  t.baseline_reset = bool(t.baseline_reset, 'transition.baseline_reset');
  t.auto_from_recent = bool(t.auto_from_recent, 'transition.auto_from_recent');
  t.hold_ms = num(t.hold_ms, 'transition.hold_ms', 0, 3000);
  if (!Array.isArray(t.videos)) throw new Error('transition.videos 必须是数组');
  if (t.videos.length > 10) throw new Error('transition.videos 最多 10 个');
  t.videos = t.videos.map((url, index) => {
    const value = text(String(url), `transition.videos[${index}]`, 2048);
    if (value && !/^https?:\/\//i.test(value)) throw new Error(`transition.videos[${index}] 必须是 http(s) 地址`);
    return value;
  }).filter(Boolean);

  const s = config.naturalness.singing;
  s.suppress_idle = bool(s.suppress_idle, 'singing.suppress_idle');
  s.tail_pad_ms = num(s.tail_pad_ms, 'singing.tail_pad_ms', 0, 3000);
  s.ducking = num(s.ducking, 'singing.ducking', 0, 1);

  const d = config.naturalness.dance;
  d.segment_seconds = num(d.segment_seconds, 'dance.segment_seconds', 1, 2);
  d.bridge_action = bool(d.bridge_action, 'dance.bridge_action');
  d.bridge_text = text(d.bridge_text, 'dance.bridge_text', 20) || '面向镜头微笑';

  const i = config.naturalness.idle;
  i.interval_s = Math.round(num(i.interval_s, 'idle.interval_s', IDLE_MIN, IDLE_MAX));
  i.rest_s = Math.round(num(i.rest_s, 'idle.rest_s', REST_MIN, REST_MAX));
  return config;
}

/** 组装 /live/s_avatar/component 请求体（只放组件版接受的字段）。 */
function buildComponentBody(s2, { image, persona, rtc, libraryId, actionPrompt } = {}) {
  const config = validate(normalize(s2));
  const prompt = (actionPrompt || config.action_prompt || '').trim();
  const body = {
    model: config.model,
    resolution: config.resolution,
    image_uri: image,
    action: {
      enabled: config.action.enabled,
      library_id: libraryId || config.action.library_id || '0',
    },
    customer_rtc: rtc,
  };
  if (persona) body.persona = persona;
  if (prompt) body.avatar = { action_prompt: prompt };
  return body;
}

/** 供前端渲染的元数据：默认值、预设、范围、建议。 */
function describe() {
  return {
    defaults: clone(DEFAULTS),
    presets: Object.entries(PRESETS).map(([id, item]) => ({ id, label: item.label, hint: item.hint, value: clone(item.value) })),
    guidance: GUIDANCE.map(item => ({ ...item })),
    ranges: {
      resolution: [...RESOLUTIONS],
      idle: { interval_s: [IDLE_MIN, IDLE_MAX], rest_s: [REST_MIN, REST_MAX] },
      dance: { segment_seconds: [1, 2] },
      transition: { videos: 10, hold_ms: [0, 3000] },
      singing: { tail_pad_ms: [0, 3000], ducking: [0, 1] },
    },
    note: '组件版不接受 idle_motion / vad / llm（那是完整实时会话接口的字段）；静默小动作由本站 type=9 实现。',
  };
}

module.exports = {
  DEFAULTS,
  PRESETS,
  RESOLUTIONS,
  normalize,
  validate,
  preset,
  buildComponentBody,
  describe,
  clone,
};
