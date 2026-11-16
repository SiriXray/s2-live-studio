'use strict';
/**
 * 样板间：行业最佳实践参数 + 场景 / 人物 / 话术 / 动作模板。
 * 只负责“推荐与组合”，真正生效仍走 /api/interaction/config 与 /api/showroom/apply。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_TRIGGERS } = require('./rules');
const { getPersona } = require('./personas');

const INDUSTRIES = [
  {
    id: 'social', name: '社交直播', icon: '💬',
    tagline: '像朋友一样待在直播间，不查户口、不硬转',
    params: { silence_s: 45, idle_motion_s: 8, cold_start_delay_s: 0, smalltalk_probability: 0.85 },
    recommended: { scene_id: 'living_room', persona_id: 'tender_companion', script_id: 'social_5', action_id: 'natural' },
  },
  {
    id: 'education', name: '教育', icon: '📚',
    tagline: '先结论、再例子、最后小检查；每 15–20 分钟一个反馈',
    params: { silence_s: 60, idle_motion_s: 12, cold_start_delay_s: 0, smalltalk_probability: 0.6 },
    recommended: { scene_id: 'scholar', persona_id: 'elegant_edu', script_id: 'education_20', action_id: 'education' },
  },
  {
    id: 'commerce', name: '带货', icon: '🛍️',
    tagline: '30s 开场、3min 单品、1min 答疑、真实机制；先适合谁，再价格',
    params: { silence_s: 25, idle_motion_s: 6, cold_start_delay_s: 0, smalltalk_probability: 0.7 },
    recommended: { scene_id: 'market', persona_id: 'hype_sales', script_id: 'commerce_5', action_id: 'commerce' },
  },
  {
    id: 'local', name: '本地生活', icon: '📍',
    tagline: '场景先行、到店路径清楚、价格透明，不喊“最后一天”',
    params: { silence_s: 40, idle_motion_s: 9, cold_start_delay_s: 0, smalltalk_probability: 0.8 },
    recommended: { scene_id: 'kitchen', persona_id: 'lively_rural', script_id: 'local_5', action_id: 'lively' },
  },
  {
    id: 'gaming', name: '影游互动', icon: '🎭',
    tagline: '角色先立住，再让玩家做选择；记得上一轮的账',
    params: { silence_s: 35, idle_motion_s: 10, cold_start_delay_s: 0, smalltalk_probability: 0.75 },
    recommended: { scene_id: 'palace', persona_id: 'npc_gui_fei', script_id: 'npc_scene', action_id: 'stage' },
  },
  {
    id: 'music', name: '音乐电台', icon: '🎵',
    tagline: '低声、留白、讲歌背后的故事；不要每句都高能',
    params: { silence_s: 50, idle_motion_s: 14, cold_start_delay_s: 0, smalltalk_probability: 0.7 },
    recommended: { scene_id: 'stage', persona_id: 'velvety_night', script_id: 'music_5', action_id: 'natural' },
  },
];

const SCENES = [
  { id: 'living_room', name: '深夜客厅', subtitle: '暖光、沙发、半身', image: '/looks/look-wet-hair.jpg', accent: '#b98cff', outfit_name: '湿发故事感', prompt: '暖色台灯、客厅沙发、半身景，像朋友视频聊天' },
  { id: 'scholar', name: '知识书房', subtitle: '书桌、白板、安静', image: '/looks/look-scholar-suit.jpg', accent: '#6fb7ff', outfit_name: '知性西装', prompt: '书房、书桌、白板/纸笔，干净侧光，适合讲解' },
  { id: 'market', name: '卖场直播', subtitle: '展台、产品、暖光', image: '/looks/look-dark-suit-m.jpg', accent: '#ffb15c', outfit_name: '带货女主播', prompt: '小型展台、产品在镜头前、暖色卖场灯，适合带货' },
  { id: 'kitchen', name: '田园厨房', subtitle: '灶台、自然光、生活感', image: '/looks/look-jeans-fresh.jpg', accent: '#8fd694', outfit_name: '元气牛仔', prompt: '厨房/餐桌、自然光、生活物件，适合本地生活' },
  { id: 'palace', name: '影游宫宴', subtitle: '宫灯、红金、角色感', image: '/looks/look-queen-long.jpg', accent: '#ff7a9d', outfit_name: '影游NPC·萧贵妃', prompt: '宫宴、红金、烛光，人物半身或全身，适合 NPC' },
  { id: 'stage', name: '音乐舞台', subtitle: '暗场、侧光、留白', image: '/looks/look-maid-blue.jpg', accent: '#7fd7ff', outfit_name: '甜心女仆', prompt: '暗色舞台、侧逆光、麦克风，适合音乐/电台' },
];

const SCRIPTS = [
  {
    id: 'social_5', name: '社交 5 段', industry: '社交直播', duration: '约 5 分钟',
    goal: '欢迎 → 接弹幕 → 话题 → 礼物 → 收尾',
    opening: '来了呀，先坐，慢慢聊。今天不赶流程，先说说你今天过得怎么样？',
    segments: [
      { label: '欢迎', text: '读名字 + 一句具体观察；不要只“欢迎”。' },
      { label: '接弹幕', text: '复述关键词 → 回应 → 一个具体反问。' },
      { label: '话题', text: '分享一个 20–30 秒的小故事，讲人，不讲参数。' },
      { label: '礼物', text: '轻礼一句带过；重礼给专属回应，不每礼必尖叫。' },
      { label: '收尾', text: '明确告别，约下一次，不突然消失。' },
    ],
  },
  {
    id: 'education_20', name: '教育 20 分钟', industry: '教育', duration: '约 20 分钟',
    goal: '导入 → 概念 → 例题 → 小测 → 答疑',
    opening: '今天只解决一个问题：怎么把学过的东西真正用起来。我先给结论，再讲为什么，最后一道小检查。',
    segments: [
      { label: '导入', text: '抛 1–2 个具体问题，说明听完能掌握什么。' },
      { label: '概念', text: '结论 → 为什么 → 正例 → 反例。' },
      { label: '例题', text: '白板/演示，边讲边圈重点。' },
      { label: '小测', text: '一道易错题，正确率低于 70% 当场重讲。' },
      { label: '答疑', text: '集中回答 3–5 个代表问题，布置下一步。' },
    ],
  },
  {
    id: 'commerce_5', name: '带货 5 段', industry: '带货', duration: '约 4–5 分钟',
    goal: '30s 开场 → 3min 单品 → 1min 答疑 → 真实机制',
    opening: '刚进来的家人们，晚上好，先别急着拍。今天这个品我只讲三点：适合谁、为什么值、什么机制。',
    segments: [
      { label: '30s 开场', text: '先别急着拍；只讲一个品；给适合/不适合。' },
      { label: '3min 单品', text: '一个卖点 + 场景 + 演示 + 对比 + 适合谁。' },
      { label: '1min 答疑', text: '接弹幕问题，先回答适合/不适合。' },
      { label: '真实机制', text: '真实价格、库存、结束时间；给不买的人体面。' },
    ],
  },
  {
    id: 'local_5', name: '本地生活 5 段', industry: '本地生活', duration: '约 5 分钟',
    goal: '场景 → 产品 → 价格 → 到店 → 收尾',
    opening: '今天不绕弯子，先带你看场景，再告诉你适合谁、怎么到店。',
    segments: [
      { label: '场景', text: '先看环境/使用场景，不要先报价格。' },
      { label: '产品', text: '一个核心体验 + 一个真实细节。' },
      { label: '价格', text: '真实价格/套餐，不制造假限时。' },
      { label: '到店', text: '地址、营业时间、预约方式说清楚。' },
      { label: '收尾', text: '适合再来，不适合别冲动。' },
    ],
  },
  {
    id: 'npc_scene', name: '影游 NPC 场景', industry: '影游互动', duration: '约 5 分钟',
    goal: '角色开场 → 试探 → 冲突 → 抉择 → 收束',
    opening: '本宫乏了，你有事便说，无事便退下吧。',
    segments: [
      { label: '角色', text: '先立身份/目的，不要跳出角色。' },
      { label: '试探', text: '问玩家一个带立场的问题。' },
      { label: '冲突', text: '让选择有代价，记得上一轮选择。' },
      { label: '抉择', text: '给 2–3 个选项，不替玩家做决定。' },
      { label: '收束', text: '给结果/悬念，约下一轮。' },
    ],
  },
  {
    id: 'music_5', name: '音乐电台 5 段', industry: '音乐电台', duration: '约 5 分钟',
    goal: '开场 → 点歌 → 故事 → 唱段 → 收尾',
    opening: '晚上好，老时间，老地方。今天先听一首慢的，再聊你们的故事。',
    segments: [
      { label: '开场', text: '低声、慢一点，说明今晚的氛围。' },
      { label: '点歌', text: '报歌名/序号，选一首有故事的。' },
      { label: '故事', text: '讲 20 秒歌背后的画面，不念百科。' },
      { label: '唱段', text: '短唱段，留白，不硬顶高音。' },
      { label: '收尾', text: '谢谢陪伴，约下一次。' },
    ],
  },
];

const ACTION_TEMPLATES = [
  {
    id: 'natural', name: '自然社交', desc: '头部微调 + 视线偏移 + 少量手势，讲完回位',
    groups: {
      greet: ['面向镜头微笑', '轻轻点头'],
      silence: ['凑近镜头看弹幕，捂嘴笑回位', '头部微倾倾听'],
      idle: ['面向镜头微笑', '轻轻点头', '掩嘴轻笑', '眨眨眼', '头部微倾倾听'],
      gift_mid: ['单手比心', '轻轻点头'],
      gift_high: ['作揖感谢', '轻轻拍手'],
      pk: ['加油打气'],
      talent: ['面向镜头微笑'],
    },
  },
  {
    id: 'commerce', name: '带货展示', desc: '前倾看弹幕 + 展示细节 + 点头确认，节奏更快',
    groups: {
      greet: ['面向镜头微笑'],
      silence: ['凑近屏幕点头，回位坐正', '看一眼弹幕，微笑转回镜头'],
      idle: ['面向镜头微笑', '轻轻点头', '凑近屏幕点头，回位坐正'],
      gift_mid: ['轻轻点头'],
      gift_high: ['拍手叫好'],
      pk: ['加油打气'],
      talent: ['面向镜头微笑'],
    },
  },
  {
    id: 'education', name: '教育讲解', desc: '倾听 + 点头 + 侧目思考，动作更少更稳',
    groups: {
      greet: ['轻轻点头'],
      silence: ['头部微倾倾听', '轻轻点头'],
      idle: ['头部微倾倾听', '轻轻点头', '视线扫向侧面，再转回镜头'],
      gift_mid: ['轻轻点头'],
      gift_high: ['作揖感谢'],
      pk: ['加油打气'],
      talent: ['面向镜头微笑'],
    },
  },
  {
    id: 'stage', name: '影游角色', desc: '端住角色姿态，少用现代主播手势',
    groups: {
      greet: ['面向镜头微笑'],
      silence: ['头部微倾倾听'],
      idle: ['轻轻点头', '视线扫向侧面，再转回镜头'],
      gift_mid: ['轻轻点头'],
      gift_high: ['作揖感谢'],
      pk: ['示意安静'],
      talent: ['面向镜头微笑'],
    },
  },
  {
    id: 'lively', name: '活泼生活', desc: '挥手/眨眼/比心，动作轻快但不连续',
    groups: {
      greet: ['轻轻挥手', '面向镜头微笑'],
      silence: ['掩嘴轻笑', '轻轻点头'],
      idle: ['轻轻挥手', '眨眨眼', '单手比心', '掩嘴轻笑'],
      gift_mid: ['单手比心'],
      gift_high: ['轻轻拍手'],
      pk: ['加油打气'],
      talent: ['面向镜头微笑'],
    },
  },
];

const byId = (list, id) => list.find(item => item.id === id) || null;

function defaultState() {
  const industry = INDUSTRIES[0];
  const scene = byId(SCENES, industry.recommended.scene_id);
  const script = byId(SCRIPTS, industry.recommended.script_id);
  return {
    industry_id: industry.id,
    scene_id: scene.id,
    persona_id: industry.recommended.persona_id,
    script_id: script.id,
    action_id: industry.recommended.action_id,
    voice_gender: '',
    opening: script.opening,
    triggers: { ...DEFAULT_TRIGGERS, ...industry.params },
    updated_at: null,
  };
}

function catalog() {
  return {
    industries: INDUSTRIES,
    scenes: SCENES,
    scripts: SCRIPTS,
    actions: ACTION_TEMPLATES,
  };
}

function loadState(dataDir) {
  const fallback = defaultState();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'showroom.json'), 'utf8'));
    return normalizeState(raw, fallback);
  } catch {
    return fallback;
  }
}

function normalizeState(raw, base = defaultState()) {
  const state = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!byId(INDUSTRIES, state.industry_id)) state.industry_id = base.industry_id;
  if (!byId(SCENES, state.scene_id)) state.scene_id = base.scene_id;
  if (!byId(SCRIPTS, state.script_id)) state.script_id = base.script_id;
  if (!byId(ACTION_TEMPLATES, state.action_id)) state.action_id = base.action_id;
  if (!getPersona(state.persona_id)) state.persona_id = base.persona_id;
  state.opening = String(state.opening || '').trim().slice(0, 500);
  state.voice_gender = ['', 'female', 'male'].includes(state.voice_gender) ? state.voice_gender : '';
  state.triggers = { ...DEFAULT_TRIGGERS, ...(base.triggers || {}), ...(state.triggers || {}) };
  for (const key of Object.keys(state.triggers)) {
    if (!(key in DEFAULT_TRIGGERS)) delete state.triggers[key];
    else state.triggers[key] = Math.max(0, Number(state.triggers[key]) || 0);
  }
  return state;
}

function applyState(dataDir, input = {}) {
  const current = loadState(dataDir);
  const industry = byId(INDUSTRIES, input.industry_id) || byId(INDUSTRIES, current.industry_id) || INDUSTRIES[0];
  const recommended = industry.recommended;
  const next = normalizeState({
    ...current,
    industry_id: industry.id,
    scene_id: input.scene_id || recommended.scene_id,
    persona_id: input.persona_id || recommended.persona_id,
    script_id: input.script_id || recommended.script_id,
    action_id: input.action_id || recommended.action_id,
    voice_gender: input.voice_gender !== undefined ? input.voice_gender : current.voice_gender,
    opening: input.opening !== undefined ? input.opening : (byId(SCRIPTS, input.script_id || recommended.script_id)?.opening || current.opening),
    triggers: { ...current.triggers, ...industry.params, ...(input.triggers || {}) },
    updated_at: new Date().toISOString(),
  }, current);
  if (!byId(SCENES, next.scene_id)) throw Object.assign(new Error('场景 ID 不正确'), { status: 400 });
  if (!byId(SCRIPTS, next.script_id)) throw Object.assign(new Error('话术模板 ID 不正确'), { status: 400 });
  if (!byId(ACTION_TEMPLATES, next.action_id)) throw Object.assign(new Error('动作模板 ID 不正确'), { status: 400 });
  if (!getPersona(next.persona_id)) throw Object.assign(new Error('人物 ID 不正确'), { status: 400 });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'showroom.json'), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function actionGroups(actionId) {
  return (byId(ACTION_TEMPLATES, actionId) || ACTION_TEMPLATES[0]).groups;
}

module.exports = { INDUSTRIES, SCENES, SCRIPTS, ACTION_TEMPLATES, catalog, loadState, applyState, actionGroups, defaultState };
