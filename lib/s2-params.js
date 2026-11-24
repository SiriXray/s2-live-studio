'use strict';
/**
 * S2 组件版自然度参数：resolution / action / action_prompt / 唱跳转场节奏。
 * 这些参数只在“开播/转场”时使用；不绑定人设与形象。
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  model: 'vidu-s2',
  resolution: '720p',
  action: { enabled: true, library_id: '0' },
  action_prompt: '正面朝向镜头，视线稳定自然，不左右扫视；以手势和轻微点头为主，说话时保持正面',
  naturalness: {
    transition: { baseline_reset: true, switch_on_ready: true, videos: [], hold_ms: 400, auto_from_recent: true },
    singing: { suppress_idle: true, tail_pad_ms: 600, ducking: 0.35 },
    dance: { segment_seconds: 2, bridge_action: true, bridge_text: '面向镜头微笑' },
    idle: { interval_s: 0, rest_s: 0 },
  },
};

const PRESETS = [
  {
    id: 'balanced', label: '平衡（默认）', hint: '720p + 转场驻留 400ms；本地 idle 默认关闭',
    value: { resolution: '720p', naturalness: { idle: { interval_s: 0, rest_s: 0 }, transition: { hold_ms: 400 }, dance: { segment_seconds: 2 } } },
  },
  {
    id: 'singing', label: '唱歌', hint: '本地：唱尾留 600ms；ducking 当前未接入',
    value: { naturalness: { singing: { suppress_idle: true, tail_pad_ms: 600, ducking: 0.35 }, idle: { interval_s: 0, rest_s: 0 } } },
  },
  {
    id: 'dance', label: '跳舞', hint: '本地：2s 分段、动作桥接、转场驻留 400ms',
    value: { naturalness: { dance: { segment_seconds: 2, bridge_action: true }, idle: { interval_s: 0, rest_s: 0 } } },
  },
  {
    id: 'transition', label: '转场优先', hint: '先 baseline_reset，再播 1–3s 转场，驻留 600ms',
    value: { naturalness: { transition: { baseline_reset: true, hold_ms: 600 } } },
  },
  {
    id: 'low_latency', label: '低延迟', hint: '720p、短转场驻留 200ms、本地 idle 关闭',
    value: { resolution: '720p', naturalness: { transition: { hold_ms: 200 }, idle: { interval_s: 0, rest_s: 0 } } },
  },
];

const GUIDANCE = [
  { label: 'resolution', note: '官方字段。720p 更稳、1080p 更清晰；2k 只在强网/大屏用，开播后不可改。' },
  { label: 'switch_videos', note: '官方 type=16 字段：1–10 个 http(s) 视频；单个 ≤30 分钟、累计 ≤60 分钟。' },
  { label: 'switch_on_ready', note: '官方字段，默认 false：false 等前序视频播完再切；true 表示数字人准备好即切。' },
  { label: 'baseline_reset', note: '官方 type=15 信令，不是创建字段；复位闭口静息后再切转场。' },
  { label: 'singing.tail_pad_ms', note: '本地播放时序：唱完留 400–800ms 再收；不是 Vidu 字段。' },
  { label: 'singing.ducking', note: '本地预留项：当前版本未接入混音，ducking 不生效，也不是 Vidu 字段。' },
  { label: 'dance.segment_seconds', note: '本地 type=9 舞蹈分段：1–3 秒一段；不是 Vidu 创建字段。' },
  { label: 'idle.interval_s / rest_s', note: '本地 idle 时序，默认 0=关闭；组件版没有官方 idle 参数。' },
];

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalize(input = {}, base = DEFAULTS) {
  const next = { ...clone(base), ...clone(input || {}) };
  next.model = 'vidu-s2';
  next.resolution = ['720p', '1080p', '2k'].includes(next.resolution) ? next.resolution : '720p';
  next.action = {
    enabled: next.action?.enabled !== false,
    library_id: String(next.action?.library_id ?? '0').slice(0, 80) || '0',
  };
  next.action_prompt = String(next.action_prompt || '').slice(0, 20000);
  const n = next.naturalness || {};
  const b = base.naturalness || DEFAULTS.naturalness;
  next.naturalness = {
    transition: {
      baseline_reset: n.transition?.baseline_reset !== false,
      switch_on_ready: n.transition?.switch_on_ready !== false,
      videos: Array.isArray(n.transition?.videos)
        ? n.transition.videos.map(item => String(item).trim()).filter(item => /^https?:\/\//i.test(item)).slice(0, 10)
        : [],
      hold_ms: clampNumber(n.transition?.hold_ms, 0, 5000, b.transition.hold_ms),
      auto_from_recent: n.transition?.auto_from_recent !== false,
    },
    singing: {
      suppress_idle: n.singing?.suppress_idle !== false,
      tail_pad_ms: clampNumber(n.singing?.tail_pad_ms, 0, 3000, b.singing.tail_pad_ms),
      ducking: clampNumber(n.singing?.ducking, 0, 1, b.singing.ducking),
    },
    dance: {
      segment_seconds: clampNumber(n.dance?.segment_seconds, 1, 10, b.dance.segment_seconds),
      bridge_action: n.dance?.bridge_action !== false,
      bridge_text: String(n.dance?.bridge_text || b.dance.bridge_text).slice(0, 40),
    },
    idle: {
      interval_s: clampNumber(n.idle?.interval_s, 0, 120, b.idle.interval_s),
      rest_s: clampNumber(n.idle?.rest_s, 0, 30, b.idle.rest_s),
    },
  };
  return next;
}

function load(dataDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(path.join(dataDir, 's2-params.json'), 'utf8')));
  } catch {
    return clone(DEFAULTS);
  }
}

function save(dataDir, input) {
  const next = normalize(input);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 's2-params.json'), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function catalog() {
  return { presets: PRESETS, guidance: GUIDANCE, note: '参数只影响下一次开播/转场；直播中可改，但分辨率与动作库要重开才生效。' };
}

function preview(dataDir, input) {
  const s2 = normalize(input, load(dataDir));
  return {
    model: s2.model,
    resolution: s2.resolution,
    action: s2.action,
    action_prompt: s2.action_prompt,
    naturalness: s2.naturalness,
  };
}

module.exports = { DEFAULTS, PRESETS, GUIDANCE, load, save, catalog, preview, normalize };
