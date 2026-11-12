'use strict';
/**
 * PRD-V2 互动组合策略：弹幕意图分类与优先级（P0-P5）、礼物档位、触发组合示例。
 * 表格内容来自 PRD 二、互动组合策略矩阵 与 四、PK节点的专项配置。
 */

// 弹幕意图层级：数字越小优先级越高，高优先级意图优先插队响应
const INTENTS = [
  { tier: 0, id: 'gift', name: '礼物 / 打赏', examples: ['送出"火箭"'], handling: '即时语音致谢 + 触发礼物对应动作/特效' },
  { tier: 1, id: 'dress', name: '换装 / 换场景指令', examples: ['换那套红色裙子', '去海边'], handling: '触发 S2 Editing switch_prompt' },
  { tier: 2, id: 'talent', name: '才艺点播', examples: ['跳个舞', '唱一句'], handling: '触发 motion control 2 / MV / 特效' },
  { tier: 3, id: 'question', name: '直接提问 / 互动请求', examples: ['主播多大', '夸夸我'], handling: '人设化语音回复' },
  { tier: 4, id: 'smalltalk', name: '闲聊 / 情绪弹幕', examples: ['哈哈哈', '好美'], handling: '轻量接话或选择性回应' },
  { tier: 5, id: 'noise', name: '低价值 / 干扰', examples: ['引流', '低俗', '无关新闻'], handling: '过滤，不进入调度队列' },
];

const MATCHERS = [
  { tier: 5, intent: 'noise', name: '引流/广告', patterns: [/加\s*[v微信]/, /私人?微信/, /引流/, /代刷/, /低价\s*(推广|出)/, /广告合作/, /外宣/, /刷单/, /博彩|赌博|下注/, /上?门的?特殊服务/, /裸[聊播]/] },
  { tier: 5, intent: 'noise', name: '低俗/无关', patterns: [/低俗/, /政治/, /新闻联播/, /涉政/, /骂人|滚|傻[逼子]/] },
  { tier: 0, intent: 'gift', name: '礼物提及', patterns: [/送出/, /礼物/, /打赏/, /火箭/, /嘉年华/, /小心心/, /灯牌/] },
  { tier: 1, intent: 'dress', name: '换装/换场景', patterns: [/换[装衣衣服装束]/, /(穿|来|换)[一那这套]*[件套]?\s*(红|白|黑|蓝|粉|紫)?色?裙子/, /红裙|旗袍|JK|汉服|礼服|西装/, /换(个|一下|那|这)?(背景|场景|场地|风格|人物)/, /去(海边|雪山|森林|太空|舞台|客厅|卧室)/] },
  { tier: 2, intent: 'talent', name: '才艺点播', patterns: [/跳舞|跳个舞|来段舞|舞一[段曲]/, /唱歌|唱一[句首段]|来一[句首]歌|点歌/, /才艺/, /来一个/, /秀一?下/, /翻个跟头|劈叉|转圈/] },
  { tier: 3, intent: 'question', name: '提问/互动请求', patterns: [/[?？]/, /^主播/, /多大|几岁|哪里人|多高/, /夸夸我|夸我/, /你好|在吗|在不在/, /介绍一?下/, /怎么|为什么|什么.{0,6}(意思|区别)/, /说.{0,4}(说|一下)/] },
  { tier: 4, intent: 'smalltalk', name: '闲聊/情绪', patterns: [/哈哈|嘻嘻|嘿嘿/, /好美|好看|漂亮|可爱|帅/, /666|233|牛|厉害/, /喜欢|爱你|加油/, /笑死|乐死|绷不住/] },
];

/** 弹幕意图分类：命中优先级最高（数字最小）的层级；无命中默认 P4 闲聊 */
function classifyComment(text, context = {}) {
  const value = String(text || '').trim();
  if (!value) return { tier: 5, intent: 'noise', matched: '空弹幕', handling: '过滤，不进入调度队列' };
  for (const matcher of MATCHERS) {
    for (const pattern of matcher.patterns) {
      const hit = value.match(pattern);
      if (hit) {
        // PK 期间：闲聊降级为过滤（PRD：PK期间弹幕调度应降低闲聊优先级，把带宽留给礼物致谢和拉票指令）
        if (matcher.tier === 4 && context.phase === 'pk') {
          return { tier: 5, intent: 'noise', matched: matcher.name, handling: 'PK期间闲聊降级过滤', demoted: true };
        }
        const intent = INTENTS.find(item => item.tier === matcher.tier);
        return { tier: matcher.tier, intent: intent.id, name: intent.name, matched: matcher.name, handling: intent.handling };
      }
    }
  }
  if (context.phase === 'pk') return { tier: 5, intent: 'noise', matched: 'PK期间未识别弹幕', handling: 'PK期间闲聊降级过滤', demoted: true };
  const intent = INTENTS.find(item => item.tier === 4);
  return { tier: 4, intent: intent.id, name: intent.name, matched: '默认', handling: intent.handling };
}

// 礼物档位表（PRD 落地建议3）：档位阈值单位为元，可在中控台调整
const DEFAULT_GIFT_TIERS = [
  { id: 'low', name: '低档', max: 10, handling: '致谢 + 小动作' },
  { id: 'mid', name: '中档', min: 10, max: 100, handling: '开放换装 / 点舞选择' },
  { id: 'high', name: '高档', min: 100, handling: '强制触发舞蹈 / 特效 + 专属口播' },
];

function giftTier(value, tiers = DEFAULT_GIFT_TIERS) {
  const amount = Number(value) || 0;
  const found = tiers.find(tier => (tier.min === undefined || amount >= tier.min) && (tier.max === undefined || amount <= tier.max));
  return found ? found.id : 'high';
}

// 触发组合示例（PRD "3. 触发组合示例（可直接作为规则引擎配置）"），引擎与链路图共用
const RULE_PRESETS = [
  { id: 'rule_dress', trigger: '弹幕含"换装/衣服/裙子/西装"', persona: '任意', dialogue: '好，满足你，看好了——', visual: { kind: 'dress', editing_type: 'virtual_tryon', note: 'S2 Editing virtual_tryon + 新参考图，switch_prompt' }, tier: 1 },
  { id: 'rule_talent', trigger: '弹幕含"跳舞/来一个/才艺"', persona: '甜美元气 / 御姐 / 搞笑', dialogue: '点名了是吧？那我可不客气了', visual: { kind: 'dance', template: 'motion_control_2', note: '选择含"舞"关键词模板（如醉酒舞等）' }, tier: 2 },
  { id: 'rule_gift_mid', trigger: '礼物价值 ≥ 中档', persona: '甜美元气', dialogue: '谢谢宝贝！你想看什么，换装还是跳舞？', visual: { kind: 'action', actions: ['作揖感谢'], note: '致谢动作 + 开放下一轮指令选择' }, tier: 0 },
  { id: 'rule_pk_start', trigger: 'PK 开始', persona: '全部', dialogue: '家人们，这一局靠你们了，扣1让我看到', visual: { kind: 'effect', scene: 'pk_arena', note: '切换 PK 专属场景/特效' }, tier: 0 },
  { id: 'rule_silence_30s', trigger: '连续冷场 30s', persona: '搞笑俏皮', dialogue: '不会吧，直播间安静得我能听见空调声', visual: { kind: 'action', actions: ['手指点下巴思考'], note: '轻微晃动/表情动作' }, tier: -1 },
];

// 默认唤醒触发配置（时间 + 状态 + 事件三重触发）
const DEFAULT_TRIGGERS = {
  cold_start_delay_s: 15,      // 收到视频帧后多久做冷启动唤醒
  silence_s: 40,               // 连续冷场阈值（微互动已每 2 拍一次，LLM 深话题作为更长的兜底）
  talent_anchor_min: 9,        // 才艺时间锚点（PRD：每 8-10 分钟，取中值）
  pk_vote_interval_s: 30,      // PK 拉票间隔
  smalltalk_probability: 0.8,  // P4 闲聊的响应概率（提高响应率，少让弹幕落空）
  queue_max: 3,                // P3 提问队列上限，超出丢最旧
  preempt_max_tier: 2,         // tier ≤ 2 才允许打断当前播报插队
  idle_motion_s: 5,            // 静默微动作：无播报时每隔多少秒补一个待机微动作（画面轨；约每 20s 插一句轻互动；须短于 silence_s；单个动作 ≤3s）
};

function defaultInteractionConfig() {
  return {
    persona_id: 'sweet_energy',
    voice_gender: '',          // 音色性别偏好：''=跟随人设，'female'/'male'=固定用女声/男声（每个人设都配双音色）
    triggers: { ...DEFAULT_TRIGGERS },
    gift_tiers: DEFAULT_GIFT_TIERS.map(tier => ({ ...tier })),
    rule_presets: RULE_PRESETS,
    intents: INTENTS,
    opening: '',
    updated_at: null,
  };
}

/** 校验中控台提交的配置补丁（人设清单以 personas.js 为准，不再硬编码） */
function normalizeInteractionConfig(patch, base = defaultInteractionConfig()) {
  const { getPersona } = require('./personas');
  const next = structuredClone(base);
  if (patch.opening !== undefined) {
    const opening = String(patch.opening).trim();
    if (opening.length > 500) throw Object.assign(new Error('开场白最长 500 字'), { status: 400 });
    next.opening = opening;
  }
  if (patch.persona_id !== undefined) {
    if (!getPersona(patch.persona_id)) throw new Error('人设ID不正确');
    next.persona_id = patch.persona_id;
  }
  if (patch.voice_gender !== undefined) {
    if (!['', 'female', 'male'].includes(patch.voice_gender)) throw new Error('音色性别偏好须为空、female 或 male');
    next.voice_gender = patch.voice_gender;
  }
  if (patch.triggers !== undefined) {
    if (!patch.triggers || typeof patch.triggers !== 'object' || Array.isArray(patch.triggers)) throw new Error('唤醒触发配置不正确');
    for (const [key, value] of Object.entries(patch.triggers)) {
      if (!(key in DEFAULT_TRIGGERS)) throw new Error(`未知触发配置项：${key}`);
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) throw new Error(`触发配置 ${key} 须为非负数值`);
      next.triggers[key] = key === 'smalltalk_probability' ? Math.min(1, number) : number;
    }
  }
  if (patch.gift_tiers !== undefined) {
    if (!Array.isArray(patch.gift_tiers) || patch.gift_tiers.length !== 3) throw new Error('礼物档位须为3档');
    next.gift_tiers = patch.gift_tiers.map((tier, index) => {
      const id = ['low', 'mid', 'high'][index];
      const name = ['低档', '中档', '高档'][index];
      const min = tier.min === undefined || tier.min === null || tier.min === '' ? undefined : Number(tier.min);
      const max = tier.max === undefined || tier.max === null || tier.max === '' ? undefined : Number(tier.max);
      if ((min !== undefined && (!Number.isFinite(min) || min < 0)) || (max !== undefined && (!Number.isFinite(max) || max < 0))) throw new Error('礼物档位阈值须为非负数值');
      if (min !== undefined && max !== undefined && min > max) throw new Error('礼物档位下限不能大于上限');
      return { id, name, handling: typeof tier.handling === 'string' && tier.handling.trim() ? tier.handling.trim().slice(0, 60) : DEFAULT_GIFT_TIERS[index].handling, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    });
  }
  next.updated_at = new Date().toISOString();
  return next;
}

module.exports = { INTENTS, MATCHERS, RULE_PRESETS, DEFAULT_TRIGGERS, DEFAULT_GIFT_TIERS, classifyComment, giftTier, defaultInteractionConfig, normalizeInteractionConfig };
