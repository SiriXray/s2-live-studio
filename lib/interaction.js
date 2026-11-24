'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listPersonas, getPersona, styleInstruction } = require('./personas');
const { classifyComment, giftTier, defaultInteractionConfig, normalizeInteractionConfig } = require('./rules');
const { reply, synthesizeWithFallback, stripSoundTags } = require('./ai');
const { createGames } = require('./games');

/**
 * PRD-V2 主动唤醒与互动组合策略引擎：对话轨（LLM 人设化回复）与画面轨
 * （S2 动作 / Editing 换装 / motion_control_2 舞蹈 / 特效）由同一调度器并行输出。
 */

const MAX_AUDIT = 200;
/** type9 静默微动作池：以手势/点头/微笑为主，正面朝向镜头；规避点赞、歪头、视线扫视类动作。 */
const IDLE_MOTION_POOL = [
  '凑近屏幕点头，回位坐正', '身体前倾点头，回正微笑', '面向镜头微笑',
  '轻轻点头', '掩嘴轻笑', '轻轻撩一下头发', '眨眨眼', '单手比心', '轻轻拍手', '轻轻挥手',
];
/** type9 规避动作：点赞类、歪头类、视线飘忽类不上动作轨 */
const IDLE_MOTION_DENY = /歪头|点赞|头部微倾|视线|侧目|看弹幕|扫视|眼神|左右看/;
/** 口播-动作匹配节拍：口播期间每 ~5s 一个动作 cue（单个 ≤3s） */
const SPEECH_ACTION_INTERVAL_MS = 5000;
/** 微互动话术池：与人设专属话术交替使用，让主播「不冷场」——引导关注/提问/点赞/预告 */
const IDLE_CHATTER_POOL = [
  '刚进来的朋友点点关注，点关注不迷路，精彩内容马上安排。',
  '觉得主播今天状态不错的，公屏扣个1让我看到你们。',
  '想听歌还是想看才艺？弹幕告诉我，人多的那个马上安排。',
  '有什么想聊的话题尽管发弹幕，我看到就接。',
  '点赞别停，冲到下一波主播就给大家加更福利。',
  '新来的朋友先停留一分钟，先做个自我介绍，也想知道你们是哪里来的呀。',
  '弹幕里扣出你们最想问的问题，主播现场回答。',
  '喜欢主播的加个粉丝团，直播间的小活动可别错过了。',
  '我先说个小事暖场：今天出门的时候风特别舒服，你们那边天气怎么样？',
  '你们最近有没有刷到什么停不下来的视频？分享一下，我去看看。',
  '如果今天能实现一个很小的愿望，你会许什么？我在公屏等你们。',
  '猜猜我接下来准备干嘛？猜对的下一轮我先点名夸你。',
  '我喜欢一边聊一边听你们报城市，感觉大家突然就近了。',
  '有没有人和我一样，喜欢把外卖摆好再开动？总感觉这样才完整。',
];

/** 通用语气词池：模板直出的话术按人设频率在句首垫一个，让主播更像真人随口开腔（哈哈哈/嗯嗯/啊——…） */
const FILLER_POOL = ['哈哈哈，', '嗯嗯，', '啊——', '嗯，', '诶，', '啊，'];
const FILLER_START_RE = /^[嗯哈啊诶哎哦哇嚯呀哟呜嘿唉呵]/;
const SOUND_TAG_TEST_RE = /\((?:laughs|chuckle|sighs|emm|breath|gasps)\)/i;

/** LLM 台词兜底自然化：没有拟声标签、也没有句首语气词时，按人设 filler_rate 补一个。
 *  只补一次，不重复；寒暄/开场白不强行加，避免每句都“嗯”。 */
function naturalizeSpeech(text, person, intent, rng = Math.random) {
  const out = String(text || '').trim();
  if (!out || intent === 'cold_start') return out;
  if (SOUND_TAG_TEST_RE.test(out) || FILLER_START_RE.test(out)) return out;
  const rate = typeof person?.filler_rate === 'number' ? person.filler_rate : 0.45;
  if (rng() > rate * 0.8) return out;
  const pool = [...new Set([...FILLER_POOL, ...(Array.isArray(person?.fillers) ? person.fillers : [])])];
  return pool[Math.floor(rng() * pool.length)] + out;
}

function createInteraction(options = {}) {
  const store = options.store;
  const transport = options.transport || fetch;
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const rng = options.rng || Math.random;
  const now = options.now || (() => Date.now());
  const config_file = path.join(dataDir, 'interaction-config.json');
  const logFile = path.join(dataDir, 'interaction-log.jsonl');
  const games = createGames({ dataDir, rng, now });

  /** 模板台词注入语气词：按人设 filler_rate 概率在句首垫前缀；开场白（用户亲写）不加；句首已有语气词不叠加 */
  function withFiller(text, person, intent) {
    if (!text || intent === 'cold_start') return text;
    const rate = typeof person?.filler_rate === 'number' ? person.filler_rate : 0.45;
    if (rng() > rate) return text;
    if (/^[嗯哈啊诶哎哦哇嚯呀哟呜嘿唉呵]/.test(text)) return text;
    const pool = [...new Set([...FILLER_POOL, ...(Array.isArray(person?.fillers) ? person.fillers : [])])];
    return pool[Math.floor(rng() * pool.length)] + text;
  }

  let config = loadConfig();
  let actionTemplate = null;
  let audit = [];
  const state = {
    phase: 'idle',            // idle | live | pk
    live_id: null,
    opened: false,            // 是否已做冷启动唤醒
    openedAt: 0,
    startedAt: 0,
    lastSpeechAt: 0,          // 主播最后一次开口
    lastMotionAt: 0,          // 最后一次画面动作（播报/静默小动作），驱动静默小动作节拍
    lastTalentAt: 0,
    lastVoteAt: 0,
    busy: null,               // { plan_id, tier, at }
    lastGift: null,           // { name, tier, at, thanked } 最近一次礼物，用于微互动致谢
    queue: [],
    usedTopics: [],
    counters: { comments: 0, filtered: 0, gifts: 0, plans: 0, preempted: 0, queued: 0, ticks: 0, cold_starts: 0, silences: 0, talents: 0, pk_rounds: 0 },
  };

  function loadConfig() {
    if (fs.existsSync(config_file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(config_file, 'utf8'));
        return { ...defaultInteractionConfig(), ...saved, triggers: { ...defaultInteractionConfig().triggers, ...(saved.triggers || {}) } };
      } catch { /* 损坏则重建 */ }
    }
    return defaultInteractionConfig();
  }
  function saveConfig() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${config_file}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(`${config_file}.tmp`, config_file);
  }
  function record(entry) {
    const item = { id: `ev-${crypto.randomBytes(4).toString('hex')}`, at: new Date().toISOString(), ...entry };
    audit.push(item);
    if (audit.length > MAX_AUDIT) audit = audit.slice(-MAX_AUDIT);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(logFile, `${JSON.stringify(item)}\n`);
    } catch { /* 审计落盘失败不影响调度 */ }
    return item;
  }

  function persona() {
    const found = getPersona(config.persona_id);
    if (!found) throw new Error('当前人设不存在，请在中控台重新选择');
    return found;
  }

  function markBusy(plan) {
    state.busy = { plan_id: plan.id, tier: plan.priority, at: now() };
    state.lastSpeechAt = now();
    state.lastMotionAt = now();
    state.counters.plans++;
  }
  function busyExpired() {
    return Boolean(state.busy && now() - state.busy.at > 95 * 1000);
  }
  function clearBusy(planId) {
    if (!state.busy || (planId && state.busy.plan_id !== planId)) return false;
    state.busy = null;
    return true;
  }
  function takeQueue() {
    while (state.queue.length) {
      const candidate = state.queue.shift();
      if (now() - candidate.enqueuedAt <= 120 * 1000) return candidate;
    }
    return null;
  }

  async function personaReply(config_all, text, history, intent) {
    const person = persona();
    const natural = Number(config_all.triggers?.natural_conversation) === 1;
    const system = [config_all.live?.persona, styleInstruction(person, intent)].filter(Boolean).join('\n\n');
    const lengthRule = natural
      ? '优先做自然对话：通常 1–3 句、40–120 字，先接住对方情绪，再补充信息；允许“嗯、对、我想想”等语气词和短停顿，不要背稿、不要连续输出排比句。'
      : '通常输出 2–4 句连续口播，80至220字，不要只回一句；开场白最多700字。';
    const messages = [{ role: 'system', content: `${system}\n\n只输出适合口播的自然中文台词，不写动作指令、舞台说明、Markdown。允许并鼓励使用拟声标签：(laughs) 大笑、(chuckle) 轻笑、(sighs) 叹气、(emm) 思考、(breath) 换气、(gasps) 倒吸气；一段最多 2–3 个，必须与情绪一致。拟声标签是唯一允许的括号内容。${lengthRule}每段必须作为完整句子送 TTS，不要按逗号或短句切开；句内用逗号、省略号和语气词形成自然停顿，跨句保持同一情绪、语速和语气，下一句要接着上一句说，不要每段都用同一个开头套路。` },
      ...(history || []).slice(-8), { role: 'user', content: text }];
    const response = await transport(`${config_all.llm.base_url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config_all.llm.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config_all.llm.model, messages, stream: false, thinking: { type: 'enabled', level: 'low' }, max_tokens: 1600 }),
      signal: AbortSignal.timeout(60000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`${config_all.llm.model} 返回HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`${config_all.llm.model} 没有返回可播报的文本`);
    return content.trim().slice(0, natural ? 180 : (intent === 'cold_start' ? 900 : 360));
  }

  async function speak(text, intent, history) {
    const config_all = store.load();
    let finalText = text;
    let source = 'template';
    if (config_all.llm.api_key) {
      try { finalText = await personaReply(config_all, text, history, intent); source = 'llm'; }
      catch (error) { record({ type: 'llm_fallback', detail: error.message, intent }); }
    } else if (intent !== 'comment_question') {
      record({ type: 'llm_skip', detail: '未配置LLM，使用模板台词', intent });
    } else {
      throw new Error('请在连接设置中填写 LLM（Vidu recaption）API Key，才能人设化回复弹幕');
    }
    finalText = naturalizeSpeech(finalText, persona(), intent, rng);
    let audio = {};
    try {
      audio = finalText ? await synthesizeWithFallback(config_all, finalText, undefined, transport) : {};
    } catch (error) {
      record({ type: 'tts_error', detail: error.message, intent });
      audio = { error: error.message };
    }
    return { text: finalText, source, audio };
  }

  function pickTopic() {
    const person = persona();
    const unused = person.topics.filter((_, index) => !state.usedTopics.includes(index));
    let variant = false;
    if (!unused.length) {
      state.usedTopics = [];
      variant = true;
    }
    const pool = variant ? person.topics : person.topics.filter((_, index) => !state.usedTopics.includes(index));
    const chosen = Math.floor(rng() * pool.length);
    const index = person.topics.indexOf(pool[chosen]);
    state.usedTopics.push(index);
    return { topic: pool[chosen], variant };
  }

  function actionPlan(names) {
    return names?.length ? [{ kind: 'action', actions: names.slice(0, 2) }] : [];
  }

  /** 样板间动作模板：只覆盖 greet、silence、idle、gift 系列、pk、talent，未覆盖时回落到人设动作 */
  function setActionTemplate(groups) {
    actionTemplate = groups && typeof groups === 'object' ? groups : null;
  }

  function actionPool(key, fallback) {
    const value = actionTemplate?.[key];
    return Array.isArray(value) && value.length ? value : fallback;
  }

  /** 口播-动作匹配：边说边动。口播期间按文本语义分段匹配动作（每 ~5s 一个，单个 ≤3s，夸张动作带归位收尾）；
   *  时间轴 at_ms 随 TTS 实际时长伸缩（无 TTS 时按语速 1.15 估算约 6 字/秒），前端按 at_ms 延时下发。 */
  const SPEECH_ACTION_MAX_CUES = 6;     // 单条口播最多 6 个动作 cue，避免长口播刷屏
  const SPEECH_ACTION_RULES = [
    { re: /(谢谢|感谢|礼物|灯牌|小心心|红包)/, actions: ['单手比心', '轻轻点头'] },
    { re: /(哈哈|好笑|笑死|搞笑|有趣)/, actions: ['捂嘴轻笑，然后恢复端坐', '掩嘴轻笑'] },
    { re: /(弹幕|公屏|扣|评论|屏幕|打字)/, actions: ['凑近屏幕点头，回位坐正', '面向镜头微笑'] },
    { re: /(关注|粉丝团|加个|点个|点点)/, actions: ['凑近屏幕点头，回位坐正', '轻轻点头'] },
    { re: /(吗|呢|什么|怎么|如何|为什么|\?|？)/, actions: ['身体前倾点头，回正微笑', '轻轻点头'] },
    { re: /(欢迎|哈喽|你好|大家好|宝子|宝宝|朋友)/, actions: ['面向镜头微笑', '轻轻挥手'] },
  ];
  const SPEECH_ACTION_FALLBACK = ['面向镜头微笑', '轻轻点头', '掩嘴轻笑', '单手比心'];

  function estimateSpeechMs(text) {
    const chars = (text || '').replace(/\s/g, '').length;
    return Math.max(3000, Math.round(chars / 6 * 1000)); // 语速 1.15 下约 6 字/秒
  }

  /** 把口播文本按时间轴切段，逐段关键词匹配动作（首段用调用方指定的意图动作，其余按语义挑） */
  function speechActionCues(text, durationMs, baseActions = []) {
    const total = Math.max(3000, Number(durationMs) || estimateSpeechMs(text));
    const clean = (text || '').replace(/\s+/g, '');
    const cues = Math.min(SPEECH_ACTION_MAX_CUES, Math.max(1, Math.floor(total / SPEECH_ACTION_INTERVAL_MS)));
    const used = new Set();
    const timeline = [];
    for (let i = 0; i < cues; i++) {
      let name;
      if (i === 0 && baseActions.length) {
        name = baseActions[0];
      } else {
        const chunk = clean.slice(Math.floor(clean.length * i / cues), Math.floor(clean.length * (i + 1) / cues));
        const matched = SPEECH_ACTION_RULES.filter(rule => rule.re.test(chunk)).flatMap(rule => rule.actions).filter(name => !IDLE_MOTION_DENY.test(name));
        const pool = matched.length ? matched : SPEECH_ACTION_FALLBACK;
        const fresh = pool.filter(a => !used.has(a));
        name = (fresh.length ? fresh : pool)[Math.floor(rng() * (fresh.length ? fresh.length : pool.length))];
      }
      if (name) { used.add(name); timeline.push({ kind: 'action', actions: [name], at_ms: i * SPEECH_ACTION_INTERVAL_MS }); }
    }
    return timeline;
  }

  /** 计划的 visual 展开：action 指令替换为带 at_ms 的口播时间轴 cue；换装/舞蹈/特效保持立即下发 */
  function expandSpeechActions(visual, text, durationMs) {
    const others = [];
    let base = [];
    for (const command of visual || []) {
      if (command.kind === 'action') base = base.concat(command.actions || []);
      else others.push(command);
    }
    return [...speechActionCues(text, durationMs, base.filter(name => !IDLE_MOTION_DENY.test(name))), ...others];
  }

  /** 组合双轨输出计划 */
  async function buildPlan({ intent, tier, trigger, dialogueText, history = [], visual = [], needs_llm = true, extra = {} }) {
    const person = persona();
    const cleanDialogue = String(dialogueText || '').replace(/^\s*「[^」]{1,30}」\s*/u, '').trim();
    const templateText = withFiller(cleanDialogue, person, intent);
    const spoken = needs_llm
      ? await speak(cleanDialogue, intent, history)
      : { text: templateText, source: 'template', audio: await synthesizeWithFallback(store.load(), templateText, undefined, transport).catch(error => ({ error: error.message })) };
    const plan = {
      id: `plan-${crypto.randomBytes(4).toString('hex')}`,
      at: new Date().toISOString(),
      priority: tier,
      intent,
      trigger,
      persona: person.id,
      persona_name: person.name,
      dialogue: { text: spoken.text, speech_text: stripSoundTags(spoken.text), source: spoken.source, audio: spoken.audio?.audio || null, format: spoken.audio?.format || null, duration_ms: spoken.audio?.duration_ms || null, ...(spoken.audio?.error ? { audio_error: spoken.audio.error } : {}) },
      visual: expandSpeechActions(visual, spoken.text, spoken.audio?.duration_ms),
      ...extra,
    };
    record({ type: 'plan', intent, trigger, priority: tier, persona: person.id, source: spoken.source, text: spoken.text.slice(0, 80), visual: visual.map(item => item.kind), preempt: Boolean(extra.preempt) });
    return plan;
  }

  /** 事件入口：comment / gift / pk_start / pk_end / speech_started / speech_done / live_start / live_end */
  async function handleEvent(input) {
    const type = input.type;
    if (type === 'live_start') {
      state.phase = 'live';
      state.live_id = input.live_id || null;
      state.opened = false;
      state.openedAt = now();
      state.startedAt = now();
      state.lastSpeechAt = now();
      state.lastMotionAt = now();
      state.lastTalentAt = now();
      state.queue = [];
      state.busy = null;
      state.usedTopics = [];
      record({ type: 'live_start', detail: state.live_id });
      return { ok: true, state: snapshotState() };
    }
    if (type === 'live_end') {
      record({ type: 'live_end', detail: state.live_id });
      state.phase = 'idle';
      state.live_id = null;
      state.busy = null;
      state.queue = [];
      return { ok: true, state: snapshotState() };
    }
    if (type === 'speech_started') { markBusy({ id: input.plan_id, priority: input.tier ?? 3 }); return { ok: true }; }
    if (type === 'speech_done') return { ok: true, cleared: clearBusy(input.plan_id) };

    if (state.phase === 'idle') throw Object.assign(new Error('直播未开始，唤醒与互动引擎处于待机'), { status: 409 });

    /* 小游戏：开局/结束由中控台触发（口播+TTS直出），弹幕口令在 comment 里拦截 */
    if (type === 'game_control') {
      if (typeof input.action !== 'string' || !['start', 'stop'].includes(input.action)) throw new Error('游戏操作须为 start 或 stop');
      if (input.action === 'start') {
        const opened = games.start(input.game);
        /* tier=2（才艺级）：游戏口播可被 P0/P1 打断，观众的游戏口令与礼物也能插进来 */
        const plan = await buildPlan({ intent: 'game', tier: 2, trigger: `小游戏开局 · ${opened.game}`, dialogueText: opened.speech, visual: actionPlan(['面向镜头微笑']), needs_llm: false });
        markBusy(plan);
        return { plan, game: games.status(), state: snapshotState() };
      }
      const closed = games.stop(input.reason || '手动结束');
      if (!closed.speech) return { ok: true, game: games.status(), state: snapshotState() };
      const plan = await buildPlan({ intent: 'game', tier: 3, trigger: '小游戏收尾', dialogueText: closed.speech, visual: actionPlan(['轻轻点头']), needs_llm: false });
      markBusy(plan);
      return { plan, game: games.status(), state: snapshotState() };
    }

    if (type === 'comment') {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 300) throw new Error('弹幕内容须为1至300字');
      state.counters.comments++;
      /* 游戏进行中：命中口令的弹幕优先交给游戏裁决（模板直出+画面动作，不走LLM保证节奏） */
      if (games.status().active) {
        const move = games.handleComment(input.text);
        if (move) {
          const decision = admit(1);
          if (!decision.ok) return { dropped: true, classification: { tier: 1, intent: 'game', matched: '游戏进行中' }, detail: decision.detail, state: snapshotState() };
          const visual = actionPlan(move.actions);
          if (move.punishment_fx) visual.push({ kind: 'effect', fx: move.punishment_fx, reason: '游戏惩罚特效（具名模板）', real: true });
          const plan = await buildPlan({ intent: 'game', tier: 1, trigger: `小游戏 · ${games.status().active?.name || '结算'}`, dialogueText: move.speech, visual, needs_llm: false, extra: { game: move.result || games.status().active } });
          markBusy(plan);
          return { plan, game: games.status(), state: snapshotState() };
        }
      }
      const classification = classifyComment(input.text, { phase: state.phase });
      if (classification.tier === 5) {
        state.counters.filtered++;
        record({ type: 'filtered', reason: classification.matched, text: input.text.slice(0, 60) });
        return { dropped: true, classification, state: snapshotState() };
      }
      if (classification.tier === 4 && rng() >= config.triggers.smalltalk_probability) {
        state.counters.filtered++;
        record({ type: 'filtered', reason: '闲聊概率门未命中', text: input.text.slice(0, 60) });
        return { dropped: true, classification, filtered_by_probability: true, state: snapshotState() };
      }
      const decision = admit(classification.tier);
      if (!decision.ok) {
        state.counters.filtered++;
        record({ type: 'queued_or_dropped', detail: decision.detail, tier: classification.tier });
        if (decision.queued) { state.counters.queued++; return { queued: true, classification, state: snapshotState() }; }
        return { dropped: true, classification, detail: decision.detail, state: snapshotState() };
      }
      if (decision.preempt) state.counters.preempted++;
      return { plan: await planForComment(input, classification, decision), classification, state: snapshotState() };
    }

    if (type === 'gift') {
      state.counters.gifts++;
      const decision = admit(0);
      if (!decision.ok) return { dropped: true, detail: decision.detail, state: snapshotState() };
      if (decision.preempt) state.counters.preempted++;
      return { plan: await makeGiftPlan(input), state: snapshotState() };
    }

    if (type === 'pk_start') {
      state.counters.pk_rounds++;
      state.phase = 'pk';
      state.lastVoteAt = now();
      state.lastSpeechAt = now();
      const person = persona();
      return { plan: await buildPlan({ intent: 'pk_enter', tier: 0, trigger: 'PK发起/被连', dialogueText: person.pk.enter, visual: [...actionPlan(actionPool('pk', person.actions.pk)), { kind: 'effect', scene: 'pk_arena', note: '切换PK专属场景/特效' }], needs_llm: true }), state: snapshotState() };
    }
    if (type === 'pk_end') {
      const person = persona();
      state.phase = 'live';
      state.lastSpeechAt = now();
      const win = Boolean(input.win);
      return { plan: await buildPlan({ intent: 'pk_end', tier: 0, trigger: `PK结束 · ${win ? '胜' : '负'}`, dialogueText: win ? person.pk.end_win : person.pk.end_lose, visual: actionPlan(actionPool('pk', person.actions.pk)), needs_llm: true, extra: { pk_result: win ? 'win' : 'lose' } }), state: snapshotState() };
    }

    throw Object.assign(new Error(`不支持的事件类型：${type}`), { status: 400 });
  }

  /** 礼物→双轨计划（PRD：低档致谢+小动作；中档特效氛围+开放换装/点舞；高档强制舞蹈+礼物特效+专属口播） */
  async function makeGiftPlan(input) {
    const tier = giftTier(input.value, config.gift_tiers);
    const person = persona();
    const visual = [];
    if (tier === 'low') visual.push(...actionPlan(actionPool('gift_low', person.actions.gift_low)));
    if (tier === 'mid') { visual.push(...actionPlan(actionPool('gift_mid', person.actions.gift_mid))); visual.push({ kind: 'effect', reason: '中档礼物 → 礼物氛围特效（motion_control_2）' }); }
    if (tier === 'high') {
      visual.push(...actionPlan(actionPool('gift_high', person.actions.gift_high)));
      visual.push({ kind: 'dance', reason: '高档礼物强制触发舞蹈（档位表）', template: input.template });
      visual.push({ kind: 'effect', reason: '高档礼物 → 全屏礼物特效（motion_control_2）' });
    }
    /* 送礼玩法：游戏中送中档及以上礼物 = 向主播买情报（排除区间/透露安全线） */
    let hint = null;
    if (tier !== 'low' && games.status().active) hint = games.giftHint(tier);
    state.lastGift = { name: String(input.gift || '礼物').slice(0, 40), tier, at: now(), thanked: false };
    const dialogue = hint ? `${person.gift_lines[tier]} ${hint.speech}` : person.gift_lines[tier];
    return buildPlan({
      intent: `gift_${tier}`, tier: 0, trigger: `礼物到达 · ${tier}`,
      dialogueText: dialogue, history: input.history || [],
      /* 带游戏情报的送礼走模板直出（不走 LLM 改写，保证情报口播原文送达） */
      visual, needs_llm: tier !== 'low' && !hint,
      extra: { gift: { name: String(input.gift || '').slice(0, 40), value: Number(input.value) || 0, tier }, ...(hint ? { game_hint: hint.hint } : {}) },
    });
  }

  /** 优先级插队与排队（PRD：高优先级意图优先插队响应） */
  function admit(tier) {
    const busyActive = state.busy && !busyExpired();
    if (!busyActive) return { ok: true, preempt: Boolean(state.busy) };
    if (tier < state.busy.tier && tier <= config.triggers.preempt_max_tier) return { ok: true, preempt: true };
    if (tier === 3 && state.queue.length < config.triggers.queue_max) {
      state.queue.push({ tier, enqueuedAt: now() });
      return { ok: false, queued: true, detail: '主播正在播报，提问已排队' };
    }
    return { ok: false, detail: tier === 3 ? '提问队列已满，本轮丢弃' : '当前播报优先级相同或更高，本轮降级跳过' };
  }

  async function planForComment(input, classification, decision) {
    const person = persona();
    const history = Array.isArray(input.history) ? input.history.slice(-8) : [];
    if (classification.tier === 0) return makeGiftPlan({ ...input, value: input.value || 0 });
    if (classification.tier === 1) {
      const visual = [{ kind: 'dress', editing_type: /背景|场景|海边|雪山|森林|太空/.test(input.text) ? 'background_replacement' : 'virtual_tryon', note: 'S2 Editing switch_prompt；换背景有服装走样风险，换装建议完整人物照重开会话（PRD实测风险）' }];
      return buildPlan({ intent: 'dress', tier: 1, trigger: `弹幕指令 · ${classification.matched}`, dialogueText: '好，满足你，看好了——', history, visual, needs_llm: true, extra: { dress_warning: true } });
    }
    if (classification.tier === 2) {
      const visual = [{ kind: 'dance', reason: '才艺点播 → motion_control_2', template: input.template }];
      return buildPlan({ intent: 'talent', tier: 2, trigger: `弹幕点播 · ${classification.matched}`, dialogueText: '点名了是吧？那我可不客气了', history, visual, needs_llm: true });
    }
    if (classification.tier === 3) {
      return buildPlan({ intent: 'comment_question', tier: 3, trigger: `弹幕提问 · ${classification.matched}`, dialogueText: input.text, history, visual: actionPlan(actionPool('greet', [person.actions.greet?.[0] || '轻轻点头'])), needs_llm: true, extra: { user_text: input.text } });
    }
    const { topic } = pickTopic();
    return buildPlan({ intent: 'comment_smalltalk', tier: 4, trigger: `闲聊接话 · ${classification.matched}`, dialogueText: topic, history, visual: actionPlan(actionPool('silence', person.actions.silence)), needs_llm: true, extra: { user_text: input.text, topic } });
  }

  /** 时间+状态触发：冷启动 / 沉默 / 才艺锚点 / PK拉票。无触发时返回 null。
   *  options.force_cold_start：视频轨就绪后立即开场，不等 cold_start_delay_s。 */
  /** 微互动台词：优先感谢 5 分钟内还没谢过的礼物；否则人设专属话术与通用互动话术交替，避免连续重复 */
  function idleChatterLine(person) {
    const gift = state.lastGift;
    if (gift && !gift.thanked && now() - gift.at <= 5 * 60_000) {
      gift.thanked = true;
      const line = person.silence_lines[Math.floor(rng() * person.silence_lines.length)];
      return `刚才收到的${gift.name}我看到了，谢谢这位家人的心意，回头给你安排加更！${line}`;
    }
    const usePersona = (state.counters.idle_chatter || 0) % 2 === 0;
    state.counters.idle_chatter = (state.counters.idle_chatter || 0) + 1;
    if (usePersona) return person.silence_lines[Math.floor(rng() * person.silence_lines.length)];
    return IDLE_CHATTER_POOL[Math.floor(rng() * IDLE_CHATTER_POOL.length)];
  }

  async function tick(options = {}) {
    if (state.phase === 'idle') return null;
    state.counters.ticks++;
    const t = now();
    const seconds = key => config.triggers[key];
    if (!state.opened && options.force_cold_start) {
      state.opened = true;
      state.counters.cold_starts++;
      const person = persona();
      const plan = await buildPlan({ intent: 'cold_start', tier: 0, trigger: '冷启动唤醒（画面就绪自动开场）', dialogueText: config.opening || person.opening || '请即兴生成今天这场直播的开场白。', visual: actionPlan(actionPool('greet', person.actions.greet)), needs_llm: !config.opening });
      markBusy(plan);
      return plan;
    }
    if (state.phase === 'pk' && t - state.lastVoteAt >= seconds('pk_vote_interval_s') * 1000) {
      state.lastVoteAt = t;
      const person = persona();
      const plan = await buildPlan({ intent: 'pk_vote', tier: 0, trigger: 'PK拉票定时', dialogueText: person.pk.vote, visual: actionPlan(person.actions.pk), needs_llm: true });
      markBusy(plan);
      return plan;
    }
    if (state.phase === 'pk') return null;
    if (!state.opened && t - state.openedAt >= seconds('cold_start_delay_s') * 1000) {
      state.opened = true;
      state.counters.cold_starts++;
      const person = persona();
      const plan = await buildPlan({ intent: 'cold_start', tier: 0, trigger: '冷启动唤醒（开播/长时间无人）', dialogueText: config.opening || person.opening || '请即兴生成今天这场直播的开场白。', visual: actionPlan(actionPool('greet', person.actions.greet)), needs_llm: !config.opening });
      markBusy(plan);
      return plan;
    }
    if (state.opened && t - state.lastTalentAt >= seconds('talent_anchor_min') * 60 * 1000) {
      state.lastTalentAt = t;
      state.counters.talents++;
      const person = persona();
      const plan = await buildPlan({ intent: 'talent_anchor', tier: 2, trigger: `才艺时间锚点（每${seconds('talent_anchor_min')}分钟）`, dialogueText: person.talent_line, visual: actionPlan(actionPool('talent', person.actions.talent)), needs_llm: true });
      markBusy(plan);
      return plan;
    }
    /* 静默微动作/微互动（type9）：5s 一拍补一个待机微动作，约每 4 拍（≈20s）插一句轻互动（优先感谢刚收到的礼物） */
    if (state.opened && state.busy === null && seconds('idle_motion_s') > 0 && t - state.lastMotionAt >= seconds('idle_motion_s') * 1000) {
      state.lastMotionAt = t;
      const beat = (state.counters.idle_motions = (state.counters.idle_motions || 0) + 1);
      const person = persona();
      const pool = [...new Set(actionPool('idle', [...(person.actions.silence || []), ...IDLE_MOTION_POOL]))].filter(name => !IDLE_MOTION_DENY.test(name));
      const action = pool[Math.floor(rng() * pool.length)];
      if (beat % 4 === 0) {
        const plan = await buildPlan({
          intent: 'idle_chatter', tier: 4, trigger: `微互动（${seconds('idle_motion_s')}s节拍×4）`,
          dialogueText: idleChatterLine(person), visual: actionPlan([action]), needs_llm: false,
        });
        markBusy(plan);
        return plan;
      }
      record({ type: 'idle_motion', detail: action });
      return { idle_motion: true, trigger: `静默微动作（每${seconds('idle_motion_s')}s）`, actions: [action] };
    }
    if (state.opened && state.busy === null && t - state.lastSpeechAt >= seconds('silence_s') * 1000) {
      state.counters.silences++;
      const person = persona();
      const lines = person.silence_lines;
      const line = lines[Math.floor(rng() * lines.length)];
      const { topic } = pickTopic();
      const plan = await buildPlan({ intent: 'silence', tier: 3, trigger: `连续冷场${seconds('silence_s')}s`, dialogueText: `${line} ${topic}`, visual: actionPlan(actionPool('silence', person.actions.silence)), needs_llm: true, extra: { topic } });
      markBusy(plan);
      return plan;
    }
    return null;
  }

  /** 消费排队的提问（客户端播报完成后调用 tick 或 drain） */
  async function drain() {
    if (state.busy && !busyExpired()) return null;
    const candidate = takeQueue();
    if (!candidate) return null;
    clearBusy();
    return candidate;
  }

  function snapshotState() {
    return {
      phase: state.phase,
      live_id: state.live_id,
      opened: state.opened,
      busy: state.busy && !busyExpired() ? state.busy : null,
      queue_length: state.queue.length,
      counters: state.counters,
      last_speech_at: state.lastSpeechAt ? new Date(state.lastSpeechAt).toISOString() : null,
    };
  }
  function snapshot() {
    return {
      config,
      personas: listPersonas(),
      games: games.status(),
      state: snapshotState(),
      audit: audit.slice(-50).reverse(),
    };
  }
  function updateConfig(patch) {
    config = normalizeInteractionConfig(patch, config);
    saveConfig();
    record({ type: 'config_updated', detail: patch.persona_id ? `人设切换为 ${patch.persona_id}` : '参数更新' });
    return snapshot();
  }
  function setDryRun(value) {
    if (typeof value !== 'boolean') throw new Error('dry_run 须为布尔值');
    config.effects_dry_run = value;
    saveConfig();
    return snapshot();
  }

  return { handleEvent, tick, drain, snapshot, snapshotState, updateConfig, setActionTemplate, setDryRun, record, clearBusy, gamesStatus: () => games.status() };
}

module.exports = { createInteraction, naturalizeSpeech, IDLE_MOTION_POOL, IDLE_MOTION_DENY, SPEECH_ACTION_INTERVAL_MS };
