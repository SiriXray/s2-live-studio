'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { listVoices, activeVoiceFrom } = require('./voices');
const { VLM_MODELS } = require('./vlm');

const secretPaths = new Set(['vidu.api_key', 'llm.api_key', 'minimax.api_key', 'soul.api_key', 'vlm.api_key', 'rtc.artc.app_key', 'rtc.agora.app_certificate', 'rtc.trtc.secret_key']);
const LLM_MODELS = ['recaption3.1', 'recaption3.1-turbo', 'recaption3.2', 'recaption3.3', 'recaption3.4', 'recaption3.4-flash', 'recaption3.4-flashx'];
const SOUL_MODELS = ['loxi-speech-1.0'];
const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.example.json'), 'utf8'));

function mergeKnown(base, input, prefix = '', preserveBlank = false) {
  const result = structuredClone(base);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是对象');
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(base, key)) throw new Error(`未知配置字段：${prefix}${key}`);
    const full = `${prefix}${key}`;
    if (base[key] && typeof base[key] === 'object') {
      result[key] = mergeKnown(base[key], value, `${full}.`, preserveBlank);
    } else if (!(preserveBlank && secretPaths.has(full) && value === '')) {
      if (typeof value !== typeof base[key]) throw new Error(`配置类型错误：${full}`);
      result[key] = typeof value === 'string' ? value.trim() : value;
    }
  }
  return result;
}

function validate(config) {
  if (!['api.vidu.cn', 'api.vidu.com'].includes(config.vidu.host)) throw new Error('仅支持 Vidu 官方接入域名');
  if (!['trtc', 'artc', 'agora'].includes(config.rtc.provider)) throw new Error('请选择 ARTC、Agora 或 TRTC');
  if (!config.llm.model || !LLM_MODELS.includes(config.llm.model)) throw new Error(`LLM 模型仅支持：${LLM_MODELS.join('、')}`);
  if (!/^https:\/\/api\.vidu\.(cn|com)\/ent\/v2$/.test(config.llm.base_url)) throw new Error('LLM 接入地址仅支持 https://api.vidu.cn/ent/v2 或 https://api.vidu.com/ent/v2');
  if (!config.minimax.model || !config.minimax.voice_id) throw new Error('模型与音色不能为空');
  if (!SOUL_MODELS.includes(config.soul.model)) throw new Error(`Soul 模型仅支持：${SOUL_MODELS.join('、')}`);
  if (config.vlm.model && !VLM_MODELS.includes(config.vlm.model)) throw new Error(`VLM 模型仅支持：${VLM_MODELS.join('、')}`);
  if (config.live.persona.length > 5000) throw new Error('主持人人设最多5000字');
  if (config.minimax.speed < 0.5 || config.minimax.speed > 2 || !Number.isFinite(config.minimax.speed)) throw new Error('语速须在0.5至2之间');
  for (const provider of ['artc', 'agora', 'trtc']) {
    const ttl = config.rtc[provider].token_ttl_seconds;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error('RTC token有效期须为60至86400秒');
  }
  if (!Number.isSafeInteger(config.rtc.trtc.sdk_app_id) || config.rtc.trtc.sdk_app_id < 0) throw new Error('TRTC App ID须为正整数');
  return config;
}

function createConfigStore(options = {}) {
  const file = options.file || path.join(__dirname, '../config.json');
  const legacyFile = options.legacyFile === undefined ? path.join(__dirname, '../../vidu-s1-quickstart/config.json') : options.legacyFile;
  const environment = options.environment || process.env;
  function load() {
    let config = structuredClone(defaults);
    if (legacyFile && fs.existsSync(legacyFile)) {
      const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      for (const group of ['vidu', 'rtc']) {
        if (legacy[group]) config[group] = mergeKnown(config[group], legacy[group]);
      }
    }
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 旧版配置迁移：deepseek 组 → llm 组（DeepSeek Key 对 Vidu 接口无效，不迁移，改回落 Vidu Key）
      if (raw.llm === undefined && raw.deepseek && typeof raw.deepseek === 'object') {
        raw.llm = { api_key: '', model: 'recaption3.4' };
      }
      delete raw.deepseek;
      config = mergeKnown(config, raw);
    }
    // VLM 为可选增强：DashScope Key 支持环境变量注入（litmus 的 WAN_API_KEY 是同一把）
    for (const [group, variable] of [['vidu', 'VIDU_API_KEY'], ['llm', 'VIDU_LLM_API_KEY'], ['minimax', 'MINIMAX_API_KEY'], ['soul', 'SOUL_API_KEY'], ['vlm', 'DASHSCOPE_API_KEY']]) {
      if (!config[group].api_key) config[group].api_key = environment[variable] || '';
    }
    // LLM 未单独配置 Key 时回落复用 Vidu Key（recaption 与渲染同账号计费）
    if (!config.llm.api_key) config.llm.api_key = config.vidu.api_key;
    return validate(config);
  }
  function view() {
    const config = load();
    const visible = structuredClone(config);
    for (const field of secretPaths) {
      const parts = field.split('.');
      const key = parts.pop();
      let owner = visible;
      for (const part of parts) owner = owner[part];
      owner[`${key}_set`] = Boolean(owner[key]);
      delete owner[key];
    }
    const provider = config.rtc.provider;
    const rtc = config.rtc[provider];
    visible.readiness = {
      vidu: Boolean(config.vidu.api_key),
      llm: Boolean(config.llm.api_key),
      minimax: Boolean(config.minimax.api_key),
      soul: Boolean(config.soul.api_key && config.soul.voice_id),
      rtc: provider === 'trtc' ? Boolean(rtc.sdk_app_id && rtc.secret_key) : Boolean(rtc.app_id && (rtc.app_key || rtc.app_certificate)),
    };
    // Soul 为备选链路：未配置不阻塞开播，仅在 readiness 提示
    visible.inherits_rtc = Boolean(legacyFile && fs.existsSync(legacyFile));
    // 音色档案：前端下拉直接展示别名，避免让用户手填 voice_id
    visible.voices = listVoices();
    visible.active_voice = activeVoiceFrom(config)?.id || '';
    return visible;
  }
  function save(patch) {
    const next = validate(mergeKnown(load(), patch, '', true));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return view();
  }
  return { load, view, save };
}

module.exports = { createConfigStore, mergeKnown, defaults };
