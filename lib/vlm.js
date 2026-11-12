'use strict';
/**
 * 形象 → 音色匹配：用阿里云 DashScope 多模态模型（qwen-vl）识别形象图的
 * 性别与气质风格，再映射到音色档案（lib/voices.js 的 4 个档案）。
 *
 * 设计要点：
 * - VLM 是可选增强链路：未配置 Key 时接口直接报"未配置"，不阻塞开播。
 * - 让 VLM 输出受控 JSON（gender ∈ male/female/unknown，style 从固定四档选），
 *   映射用纯函数 matchVoiceFromAnalysis 承担，便于离线测试。
 * - DashScope 兼容 OpenAI Chat 协议（compatible-mode），图片走 data URI，
 *   服务端零文件落盘。
 */

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const VLM_MODELS = ['qwen3-vl-plus', 'qwen-vl-max-latest', 'qwen-vl-plus'];

const STYLES = [
  { key: 'steady', label: '低沉稳叙' },
  { key: 'energetic', label: '活力带货' },
  { key: 'elegant', label: '知性优雅' },
  { key: 'sweet', label: '甜美元气' },
];

const DETECT_PROMPT = `你是直播数字人的形象搭配师。观察这张主播形象图，只判断画面中人物，不要臆测画外内容。
输出一个 JSON 对象（不要 markdown、不要解释），字段：
{"gender":"male|female|unknown","style":"${STYLES.map(style => style.label).join('|')}","reason":"不超过20字的判断依据"}
说明：gender 指形象呈现的主要性别气质；style 四选一——低沉稳叙（成熟稳重、适合讲解）、活力带货（热情外放、节奏快）、知性优雅（从容精致）、甜美元气（明亮可爱）。性别或气质无法判断时 gender 用 unknown。`;

/** 解析 VLM 返回文本（容忍 markdown 代码围栏）为受控结构 */
function parseAnalysis(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  const gender = ['male', 'female', 'unknown'].includes(parsed.gender) ? parsed.gender : 'unknown';
  const style = STYLES.find(item => item.label === parsed.style)?.key || null;
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 60) : '';
  return { gender, style, reason };
}

/** 受控分析 → 音色档案映射（纯函数；voices 为 listVoices() 输出） */
function matchVoiceFromAnalysis(analysis, voices) {
  const list = Array.isArray(voices) ? voices : [];
  if (!analysis || analysis.gender !== 'male' && analysis.gender !== 'female') return null;
  const same = list.filter(voice => voice.gender === analysis.gender);
  if (!same.length) return null;
  // 男声：活力带货 → 快节奏 B 档，其余低音叙事 A 档；女声：甜美元气 → B 档，其余清透知性 A 档。
  // B/A 档按档案 id 显式匹配（新增档案不影响映射），同档多个时取列表最后一个。
  const preferB = ['energetic', 'sweet'].includes(analysis.style);
  const tierIds = preferB ? ['male_low_b', 'female_sweet_b'] : ['male_low_a', 'female_clear_a'];
  const tier = tierIds.map(id => same.find(voice => voice.id === id)).filter(Boolean);
  return tier[tier.length - 1] || same[same.length - 1] || null;
}

/** 调用 DashScope qwen-vl 识别形象图（image_uri 为 data URI） */
async function detectAvatar(config, imageUri, signal, transport = fetch) {
  if (!config.vlm?.api_key) throw new Error('请在连接设置中填写 VLM（DashScope）API Key');
  if (!VLM_MODELS.includes(config.vlm.model)) throw new Error(`VLM 模型仅支持：${VLM_MODELS.join('、')}`);
  if (typeof imageUri !== 'string' || !imageUri.startsWith('data:image/')) throw new Error('形象图须为图片 data URI');
  const response = await transport(`${config.vlm.base_url || DASHSCOPE_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.vlm.api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.vlm.model,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: imageUri } },
        { type: 'text', text: DETECT_PROMPT },
      ] }],
      stream: false,
      temperature: 0,
      max_tokens: 200,
    }),
    signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`DashScope 返回 HTTP ${response.status}，请检查 VLM Key 与模型权限`);
  const payload = await response.json();
  if (payload.base_resp?.status_code !== undefined && payload.base_resp.status_code !== 0) {
    throw new Error(`DashScope业务码 ${payload.base_resp.status_code}`);
  }
  const content = payload.choices?.[0]?.message?.content;
  const analysis = parseAnalysis(typeof content === 'string' ? content : '');
  if (!analysis) throw new Error('VLM 未返回可解析的性别判断结果');
  return analysis;
}

module.exports = { DASHSCOPE_BASE, VLM_MODELS, STYLES, DETECT_PROMPT, parseAnalysis, matchVoiceFromAnalysis, detectAvatar };
