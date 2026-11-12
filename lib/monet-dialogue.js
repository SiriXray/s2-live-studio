'use strict';
const { requestJson, validateTurn } = require('./ai');
const { getManifest, planTurn } = require('./monet');

function validateMonetProfile(profile) {
  if (profile == null) return null;
  const ids = new Set(getManifest().actions.map(action => action.id));
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      !Array.isArray(profile.allowed_action_ids) || !profile.allowed_action_ids.length ||
      profile.allowed_action_ids.some(id => !ids.has(id))) throw new Error('直播场景的许可动作不正确');
  for (const [field, limit] of [['persona', 5000], ['action_style', 2000], ['opening_instruction', 1000], ['closing_instruction', 1000], ['blocked_action_reason', 300]]) {
    if (typeof profile[field] !== 'string' || !profile[field].trim() || profile[field].length > limit) throw new Error(`直播场景字段不正确：${field}`);
  }
  for (const event of ['opening', 'closing']) {
    const id = profile.event_actions?.[event];
    if (id !== null && !profile.allowed_action_ids.includes(id)) throw new Error(`直播场景的${event}动作不在许可清单`);
  }
  if (profile.turn_actions !== undefined) {
    if (!profile.turn_actions || typeof profile.turn_actions !== 'object' || Array.isArray(profile.turn_actions) ||
        Object.entries(profile.turn_actions).some(([text, id]) => !text.trim() || text.length > 2000 || (id !== null && !profile.allowed_action_ids.includes(id)))) throw new Error('直播场景的弹幕动作映射不正确');
  }
  return structuredClone(profile);
}

async function prepareMonet(config, input, signal, transport, sceneProfile = null) {
  const profile = validateMonetProfile(sceneProfile);
  const manifest = getManifest();
  const planned = planTurn(input);
  const allActions = [...manifest.actions, ...Object.values(manifest.cues || {})];
  const findAction = id => allActions.find(action => action.id === id);
  if (input.event === 'action') {
    const action = findAction(input.action_id);
    if (!action) throw new Error('动作未在莫奈任务清单中定义');
    if (profile && !profile.allowed_action_ids.includes(action.id)) throw new Error(profile.blocked_action_reason);
    return { intent: 'action', text: '', action, needs_llm: false };
  }
  if (!config.llm.api_key) throw new Error('请在连接设置中填写 LLM（Vidu recaption）API Key');
  const available = input.available_requirements || [];
  if (!Array.isArray(available) || available.some(value => !Object.hasOwn(manifest.requirement_labels, value))) throw new Error('人物素材条件不正确');
  const turn = validateTurn({ text: input.event === 'turn' ? input.text : `当前交互阶段：${input.event}`, history: input.history || [] });
  const history = turn.history.map(message => message.role === 'assistant' ? { role: 'assistant', content: JSON.stringify({ text: message.content, action_id: null }) } : message);
  const gentleNames = ['面向镜头微笑', '轻轻点头', '歪头笑', '手指点下巴思考', '摊开双手'];
  const directedId = input.event === 'turn' && profile?.turn_actions && Object.hasOwn(profile.turn_actions, input.text) ? profile.turn_actions[input.text] : undefined;
  const requestedAction = findAction(directedId !== undefined ? directedId : profile && ['opening', 'closing'].includes(input.event) ? profile.event_actions[input.event] : planned.action_id);
  const missing = (requestedAction?.requires || []).filter(value => !available.includes(value));
  const blockedByScene = Boolean(profile && requestedAction && !profile.allowed_action_ids.includes(requestedAction.id));
  const forcedAction = missing.length || blockedByScene ? null : requestedAction;
  const candidates = directedId === null ? [] : forcedAction ? [forcedAction] : manifest.actions.filter(action => profile ? profile.allowed_action_ids.includes(action.id) : gentleNames.includes(action.name));
  const phase = {
    opening: profile?.opening_instruction || '访客刚进入。用两三句自然自我介绍和邀请，说明你是Monet无限画布的拟人伙伴、由VIDU S2驱动，不照搬示例长台词，不一次讲完所有卖点。',
    closing: profile?.closing_instruction || '访客明确告别或工作人员结束本次交流。温暖简短告别，可自然邀请去旁边平板看看无限画布，不照搬固定口号。',
    scene_ready: '已接收到Editing结果视频帧，但没有自动验收背景语义。邀请观众看看新的画面并说说感受，可关联无边界创意世界；不要保证替换准确或质量通过。',
    turn: planned.intent === 'scene' ? '用户明确请求切换背景。只先说即将尝试，不宣称已经成功；系统稍后操作。' : planned.intent === 'closing' ? '用户在告别，自然结束对话，不再追问，不销售。' : '优先回答观众本轮真实问题，结合历史保持连贯。闲聊不硬转Monet。示例台词仅是语气和能力参考，不逐字复述。',
  }[input.event];
  const instructions = `${profile?.persona || manifest.persona}\n\n本轮阶段：${phase}\n${missing.length ? `当前图片未确认条件：${missing.map(value => manifest.requirement_labels[value]).join('；')}。不能执行用户指定的${requestedAction.name}，自然解释一次并提出可行的轻动作，不假称已经完成。` : ''}\n${blockedByScene ? `${profile.blocked_action_reason}。本轮不能执行${requestedAction.name}，不假称已执行。` : ''}\n只返回JSON对象：{"text":"适合口播的自然中文","action_id":null}。text只含口播，不含动作指令、括号舞台说明、Markdown或JSON解释。通常20至100字，开场最多160字。动作是可选的：倾听、平静回答时用null，不是每句话都必须表演；一次最多一个动作，不频繁变脸。不因用户要求而输出不存在的动作。action_id只能为null或以下清单之一：${JSON.stringify(candidates.map(action => ({ id: action.id, name: action.name })))}。明确指定的动作会由导演安排执行，不要把它念出来。`;
  const response = await requestJson(`${config.llm.base_url}/chat/completions`, config.llm.api_key, {
    model: config.llm.model,
    messages: [{ role: 'system', content: instructions }, ...history, { role: 'user', content: turn.text }],
    stream: false,
    thinking: { type: 'enabled', level: 'low' },
    response_format: { type: 'json_object' },
    max_tokens: 2000,
  }, signal, transport);
  if (response.choices?.[0]?.finish_reason === 'length') throw new Error('LLM回复超过本轮长度限制；已停止本轮，不播报截断内容');
  if (!response.choices?.[0]?.message?.content?.trim()) throw new Error('LLM返回空白JSON输出；已停止本轮，请重新表达问题');
  let choice;
  try { choice = JSON.parse(response.choices?.[0]?.message?.content); } catch { throw new Error('LLM未返回有效的莫奈对话JSON；本轮不发送动作或播报，不自动重试'); }
  if (!choice || typeof choice.text !== 'string' || !choice.text.trim() || choice.text.length > 600) throw new Error('莫奈口播文本为空或过长');
  if (choice.action_id !== null && !candidates.some(action => action.id === choice.action_id)) throw new Error('LLM返回了不在本轮许可清单中的动作');
  const action = forcedAction || findAction(choice.action_id);
  return { ...planned, text: choice.text.trim(), ...(action ? { action } : {}), ...(missing.length || blockedByScene ? { action_unavailable: requestedAction.id, missing_requirements: blockedByScene ? [profile.blocked_action_reason] : missing } : {}), needs_llm: true, action_explicit: Boolean(forcedAction) };
}

module.exports = { prepareMonet, validateMonetProfile };
