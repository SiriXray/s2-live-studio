'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyComment, giftTier, defaultInteractionConfig, normalizeInteractionConfig } = require('../lib/rules');
const { createInteraction } = require('../lib/interaction');
const { createEffects } = require('../lib/effects');
const { createStudio } = require('../server');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 's2v2-'));

const CONFIG_ALL = {
  llm: { api_key: 'test-key', model: 'recaption3.4', base_url: 'https://api.vidu.cn/ent/v2' },
  minimax: { api_key: 'test-key', model: 'test-model', voice_id: 'v', speed: 1 },
  soul: { api_key: '', model: 'loxi-speech-1.0', base_url: 'https://api.loxinity.com', voice_id: '' },
  live: { persona: '你是一位主播' },
  vidu: { api_key: '', host: 'mock.example' },
};

/** 拦截 recaption LLM / MiniMax 的假 transport */
function mockTransport(url) {
  if (String(url).includes('/ent/v2/chat/completions')) {
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '好的，收到，这就安排！' } }] }) });
  }
  if (String(url).includes('minimax')) {
    return Promise.resolve({ ok: true, json: async () => ({ base_resp: { status_code: 0 }, data: { audio: 'aaaaaaaa' }, extra_info: { audio_sample_rate: 24000, audio_channel: 1, audio_format: 'pcm' } }) });
  }
  return Promise.resolve({ ok: false, status: 599, json: async () => ({}) });
}

function makeEngine(overrides = {}) {
  const dataDir = tmpDir();
  let clock = 1_000_000;
  let seed = 0.42;
  const engine = createInteraction({
    store: { load: () => CONFIG_ALL },
    transport: mockTransport,
    dataDir,
    now: () => clock,
    rng: () => seed,
    ...overrides,
  });
  return {
    engine,
    dataDir,
    advance: ms => { clock += ms; },
    setRandom: value => { seed = value; },
  };
}

/* ---------------- 规则层：意图分类与档位 ---------------- */

test('意图分类 P0-P5（PRD 二 · 互动组合策略矩阵）', () => {
  assert.equal(classifyComment('送出一个火箭').tier, 0);
  assert.equal(classifyComment('换那套红色裙子').tier, 1);
  assert.equal(classifyComment('去海边吧').tier, 1);
  assert.equal(classifyComment('跳个舞看看').tier, 2);
  assert.equal(classifyComment('主播多大呀？').tier, 3);
  assert.equal(classifyComment('哈哈哈好美').tier, 4);
  assert.equal(classifyComment('加微信看更多').tier, 5);
  assert.equal(classifyComment('低调引流代刷').tier, 5);
  assert.equal(classifyComment('随便说点什么').tier, 4, '无命中默认 P4 闲聊');
});

test('PK 期间闲聊降级为过滤（PRD 四 · PK 专项）', () => {
  const result = classifyComment('哈哈哈', { phase: 'pk' });
  assert.equal(result.tier, 5);
  assert.equal(result.demoted, true);
  assert.equal(classifyComment('主播多大？', { phase: 'pk' }).tier, 3, '提问在 PK 期间仍保留');
});

test('礼物档位映射（PRD 落地建议 3）', () => {
  const tiers = defaultInteractionConfig().gift_tiers;
  assert.equal(giftTier(5, tiers), 'low');
  assert.equal(giftTier(10, tiers), 'low');
  assert.equal(giftTier(66, tiers), 'mid');
  assert.equal(giftTier(100, tiers), 'mid');
  assert.equal(giftTier(520, tiers), 'high');
  assert.equal(giftTier(0, tiers), 'low');
});

test('配置校验：非法人设 / 非法档位抛错', () => {
  assert.throws(() => normalizeInteractionConfig({ persona_id: 'hacker' }));
  assert.throws(() => normalizeInteractionConfig({ gift_tiers: [{ max: 10 }] }));
  assert.throws(() => normalizeInteractionConfig({ triggers: { silence_s: -1 } }));
  assert.throws(() => normalizeInteractionConfig({ triggers: { unknown_key: 1 } }));
  const ok = normalizeInteractionConfig({ triggers: { silence_s: 45 }, gift_tiers: [{ max: 20 }, { min: 21, max: 200 }, { min: 201 }] });
  assert.equal(ok.triggers.silence_s, 45);
  assert.equal(ok.gift_tiers[1].min, 21);
});

/* ---------------- 引擎层：触发 / 插队 / PK / 话题池 ---------------- */

test('冷启动唤醒：开播后到达延迟即触发（PRD 三）', async () => {
  const { engine, advance } = makeEngine();
  await assert.rejects(() => engine.handleEvent({ type: 'comment', text: '你好' }), /直播未开始/);
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  assert.equal(await engine.tick(), null, '未到冷启动延时不触发');
  advance(16_000);
  const plan = await engine.tick();
  assert.equal(plan.intent, 'cold_start');
  assert.ok(plan.dialogue.text.trim(), '冷启动应有开场白');
});

test('冷启动唤醒：force_cold_start 画面就绪立即开场，无需等到延迟', async () => {
  const { engine } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L2' });
  const plan = await engine.tick({ force_cold_start: true });
  assert.equal(plan.intent, 'cold_start', '强制冷启动应立即返回开场计划');
  assert.equal(plan.trigger.includes('自动开场'), true, '触发来源应标注自动开场');
  assert.ok(plan.dialogue.text.trim());
  const again = await engine.tick({ force_cold_start: true });
  assert.equal(again, null, '已开场后不应重复触发');
});

test('优先级插队：P3 排队、P0 礼物插队（PRD 二）', async () => {
  const { engine } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  engine.handleEvent({ type: 'speech_started', plan_id: 'p-base', tier: 3 });
  const queued = await engine.handleEvent({ type: 'comment', text: '主播是哪里人？' });
  assert.equal(queued.queued, true, 'P3 提问在播报中应排队');
  const gift = await engine.handleEvent({ type: 'gift', gift: '火箭', value: 520 });
  assert.equal(gift.plan.intent, 'gift_high', '520 元 → 高档');
  assert.ok(gift.plan.visual.some(item => item.kind === 'dance'), '高档礼物强制舞蹈');
  assert.ok(gift.plan.visual.some(item => item.kind === 'effect'), '高档礼物联动礼物特效');
  assert.equal(engine.snapshotState().counters.preempted, 1);
});

test('中档礼物联动礼物氛围特效（effect 命令）', async () => {
  const { engine } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  const gift = await engine.handleEvent({ type: 'gift', gift: '灯牌', value: 66 });
  assert.equal(gift.plan.intent, 'gift_mid');
  assert.ok(gift.plan.visual.some(item => item.kind === 'effect'), '中档礼物触发特效任务');
  assert.ok(!gift.plan.visual.some(item => item.kind === 'dance'), '中档不强制舞蹈');
});

test('低档礼物走模板台词、不强制舞蹈', async () => {
  const { engine } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  const gift = await engine.handleEvent({ type: 'gift', gift: '小心心', value: 1 });
  assert.equal(gift.plan.intent, 'gift_low');
  assert.equal(gift.plan.dialogue.source, 'template');
  assert.ok(!gift.plan.visual.some(item => item.kind === 'dance'));
});

test('P5 过滤与 P4 概率门（PRD 二）', async () => {
  const { engine, setRandom } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  const spam = await engine.handleEvent({ type: 'comment', text: '加微信看福利' });
  assert.equal(spam.dropped, true);
  setRandom(0.99);
  const skipped = await engine.handleEvent({ type: 'comment', text: '哈哈哈' });
  assert.equal(skipped.dropped, true, '未命中概率门被跳过');
  setRandom(0.1);
  const answered = await engine.handleEvent({ type: 'comment', text: '哈哈哈' });
  assert.equal(answered.plan.intent, 'comment_smalltalk');
});

test('PK 状态机：进入 / 拉票 / 结束（PRD 四）', async () => {
  const { engine, advance } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  const enter = await engine.handleEvent({ type: 'pk_start' });
  assert.equal(enter.plan.intent, 'pk_enter');
  assert.equal(engine.snapshotState().phase, 'pk');
  advance(31_000);
  const vote = await engine.tick();
  assert.equal(vote.intent, 'pk_vote', 'PK 期间到点拉票');
  const end = await engine.handleEvent({ type: 'pk_end', win: true });
  assert.equal(end.plan.intent, 'pk_end');
  assert.equal(engine.snapshotState().phase, 'live');
});

test('话题池不重复（PRD：10-20 条话题用尽前不重复）', async () => {
  const { engine, setRandom } = makeEngine();
  setRandom(0.1);
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  const { PERSONAS } = require('../lib/personas');
  const persona = PERSONAS.find(item => item.id === 'sweet_energy');
  const poolSize = persona.topics.length;
  assert.ok(poolSize >= 10, `话题池至少10条，当前 ${poolSize}`);
  const topics = [];
  for (let index = 0; index < poolSize; index++) {
    const result = await engine.handleEvent({ type: 'comment', text: '哈哈哈' });
    topics.push(result.plan.topic);
    engine.handleEvent({ type: 'speech_done', plan_id: result.plan.id });
  }
  assert.equal(new Set(topics).size, poolSize, '池用尽前不得出现重复话题');
});

test('沉默唤醒在冷启动之后才生效', async () => {
  const { engine, advance } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  advance(16_000);
  const cold = await engine.tick();
  assert.equal(cold.intent, 'cold_start');
  engine.handleEvent({ type: 'speech_done', plan_id: cold.id });
  // 静默小动作节拍（20s）短于冷场唤醒（30s），先消化掉先行的小动作
  advance(21_000);
  const idle = await engine.tick();
  if (idle?.idle_motion) advance(10_000);
  const silence = await engine.tick();
  assert.equal(silence.intent, 'silence');
  assert.ok(silence.topic, '沉默唤醒应携带话题');
});

test('静默小动作：空闲节拍返回 type9 动作（纯画面轨，不出声）', async () => {
  const { engine, advance } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  const cold = await engine.tick({ force_cold_start: true });
  engine.handleEvent({ type: 'speech_done', plan_id: cold.id });
  // 拉远沉默唤醒阈值，避免抢在静默小动作之前触发
  engine.updateConfig({ triggers: { silence_s: 100000, idle_motion_s: 45 } });
  advance(46_000);
  const idle = await engine.tick();
  assert.ok(idle?.idle_motion, '空闲节拍应返回静默小动作');
  assert.ok(Array.isArray(idle.actions) && idle.actions.length, '应携带动作名（type9 上行「请做XX」）');
  advance(46_000);
  const idle2 = await engine.tick();
  assert.ok(idle2?.idle_motion, '下一次节拍应再次触发');
});

/* ---------------- 画面轨：特效 / 舞蹈 dry-run ---------------- */

test('effects：dry-run 任务与参数校验', async () => {
  const effects = createEffects({ dataDir: tmpDir(), transport: mockTransport, dryRun: true });
  await assert.rejects(() => effects.createTask(CONFIG_ALL, { kind: 'dance' }), /形象图/);
  const task = await effects.createTask(CONFIG_ALL, { kind: 'dance', image_uri: 'vir:img', aspect_ratio: '9:16' });
  assert.match(task.task_id, /^dry-/);
  assert.equal(task.state, 'dry_run');
  assert.equal(task.payload.template, 'motion_control_2');
  assert.equal(task.payload.images[0], 'vir:img');
  const status = effects.status();
  assert.equal(status.dry_run, true);
  assert.equal(status.recent[0].task_id, task.task_id);
  assert.throws(() => effects.setDryRun('yes'), /布尔/);
});

/* ---------------- 音色档案（人设 × 双链路音色） ---------------- */

test('音色档案：性别与人设一致，切换时 Soul 与 MiniMax 同时写', async () => {
  const { PERSONAS } = require('../lib/personas');
  const { listVoices, voiceForPersona } = require('../lib/voices');
  const voices = listVoices();
  assert.ok(voices.length >= 4, '音色档案至少 4 个');
  for (const persona of PERSONAS) {
    const voice = voiceForPersona(persona);
    assert.ok(voice, `${persona.id} 必须解析到音色档案`);
    assert.equal(voice.gender, persona.gender, `${persona.id} 音色性别需与人设一致`);
    assert.ok(voice.minimax, '档案必须提供 MiniMax 回落音色');
    // soul 允许为空：克隆音色退役的档案走 MiniMax 回落（synthesizeWithFallback 直接跳过 Soul）
    if (voice.soul) assert.match(voice.soul, /^(s2_|LOXI_|xiaohe)/, 'Soul 音色须为克隆、完整预置 ID 或待补短名');
  }

  const saved = [];
  const store = { load: () => CONFIG_ALL, view: () => ({ readiness: {} }), save: patch => { saved.push(patch); return {}; } };
  const server = createStudio({ store, transport: mockTransport, dataDir: tmpDir() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/api/interaction/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: 'funny_playful' }) });
    // 李现男声克隆退役后，男声人设 Soul 侧为空、直接走 MiniMax 回落
    assert.equal(saved.at(-1).soul.voice_id, '', '退役男声克隆应写空 Soul 音色');
    assert.equal(saved.at(-1).minimax.voice_id, 'junlang_nanyou', '回落音色需同性别');

    await fetch(`${base}/api/interaction/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: 'elegant_edu' }) });
    assert.equal(saved.at(-1).soul.voice_id, 's2_liuyifei_v030_11', '女声人设应切到清透女声克隆');
    assert.equal(saved.at(-1).minimax.voice_id, 'female-chengshu');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('套装绑定：造型可绑人设，切人设返回绑定形象', async () => {
  const ONE_PX_JPG = Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfa28a2803ffd9'.match(/../g).map(h => parseInt(h, 16)),
  );
  const imageUri = `data:image/jpeg;base64,${ONE_PX_JPG.toString('base64')}`;
  const store = { load: () => CONFIG_ALL, view: () => ({ readiness: {} }) };
  const server = createStudio({ store, transport: mockTransport, dataDir: tmpDir() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const imported = await (await fetch(`${base}/api/outfits/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '御姐红裙', persona_id: 'cool_queen', image_uri: imageUri }) })).json();
    assert.equal(imported.kind, 'avatar');

    const list = await (await fetch(`${base}/api/outfits`)).json();
    const bound = list.items.find(item => item.id === imported.id);
    assert.equal(bound.persona_id, 'cool_queen');

    const manifest = await (await fetch(`${base}/api/interaction/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: 'cool_queen' }) })).json();
    assert.equal(manifest.bound_outfit.id, imported.id, '切人设应返回该人设绑定的形象');
    assert.equal(manifest.bound_outfit.name, '御姐红裙');

    const other = await (await fetch(`${base}/api/interaction/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: 'funny_playful' }) })).json();
    assert.equal(other.bound_outfit, null, '未绑定形象的人设返回 null');

    const unbound = await (await fetch(`${base}/api/outfits/${imported.id}/bind`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: null }) })).json();
    assert.equal(unbound.persona_id, '');
    const bad = await fetch(`${base}/api/outfits/${imported.id}/bind`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: 'no_such' }) });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

/* ---------------- API 集成（mock 依赖，真实 HTTP） ---------------- */

test('API 集成：manifest / 事件注入 / tick / 审计日志', async () => {
  const dataDir = tmpDir();
  const store = { load: () => CONFIG_ALL, view: () => ({ readiness: {} }) };
  const server = createStudio({ store, transport: mockTransport, dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const manifest = await (await fetch(`${base}/api/interaction`)).json();
    assert.equal(manifest.personas.length, 8, 'PRD 5 种基础人设 + 3 个官方预置音色人设');
    assert.ok(manifest.config.intents.length >= 6);

    const config = await (await fetch(`${base}/api/interaction/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona_id: 'cool_queen', triggers: { silence_s: 25 } }) })).json();
    assert.equal(config.config.persona_id, 'cool_queen');
    assert.equal(config.config.triggers.silence_s, 25);

    await (await fetch(`${base}/api/interaction/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'live_start', live_id: 'L9' }) })).json();
    const gift = await (await fetch(`${base}/api/interaction/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'gift', gift: '嘉年华', value: 3000 }) })).json();
    assert.equal(gift.plan.intent, 'gift_high');
    assert.ok(gift.plan.visual.some(item => item.kind === 'dance'));

    const tick = await (await fetch(`${base}/api/interaction/tick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    assert.ok(tick.plan || tick.skip);

    const log = await (await fetch(`${base}/api/interaction/log`)).json();
    assert.ok(log.audit.some(entry => entry.type === 'plan'));

    const effect = await (await fetch(`${base}/api/effect/dance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'dance', image_uri: 'vir:img' }) })).json();
    assert.match(effect.task_id, /^dry-/);
    const effectStatus = await (await fetch(`${base}/api/effect/status`)).json();
    assert.equal(effectStatus.dry_run, true);

    const atlas = await (await fetch(`${base}/atlas.html`)).text();
    assert.match(atlas, /业务链路/);
    // 旧版楷体链路页已下线：/chain.html 仅做跳转，兼容历史书签
    const legacy = await (await fetch(`${base}/chain.html`)).text();
    assert.match(legacy, /url=\/atlas\.html/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('API 集成：视频上传与本地媒体播放（Range 续播）', async () => {
  const dataDir = tmpDir();
  const store = { load: () => CONFIG_ALL, view: () => ({ readiness: {} }) };
  const server = createStudio({ store, transport: mockTransport, dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = Buffer.from('0'.repeat(4096));
    const upload = await fetch(`${base}/api/video/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('跳舞成片.mp4') }, body });
    assert.equal(upload.status, 201);
    const meta = await upload.json();
    assert.match(meta.url, /^\/media\/videos\//);
    assert.equal(meta.size, 4096);

    const full = await fetch(`${base}${meta.url}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal((await full.arrayBuffer()).byteLength, 4096);

    const part = await fetch(`${base}${meta.url}`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 0-99/4096');
    assert.equal((await part.arrayBuffer()).byteLength, 100);

    const bad = await fetch(`${base}/api/video/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'x.txt' }, body });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${base}/media/videos/nofile.mp4`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('微互动：idle 节拍×4 插一句轻互动，优先感谢未致谢的礼物', async () => {
  const { engine, advance } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  const cold = await engine.tick({ force_cold_start: true });
  engine.handleEvent({ type: 'speech_done', plan_id: cold.id });
  engine.updateConfig({ triggers: { silence_s: 100000, idle_motion_s: 12 } });
  advance(13_000);
  assert.equal((await engine.tick())?.idle_motion, true);
  advance(13_000);
  assert.equal((await engine.tick())?.idle_motion, true);
  const gift = await engine.handleEvent({ type: 'gift', gift: '灯牌', value: 66 });
  engine.handleEvent({ type: 'speech_done', plan_id: gift.plan.id });
  advance(13_000);
  assert.equal((await engine.tick())?.idle_motion, true);
  advance(13_000);
  const chatter = await engine.tick();
  assert.equal(chatter?.intent, 'idle_chatter');
  assert.match(chatter.dialogue.text, /灯牌/);
  assert.match(chatter.dialogue.text, /谢谢/);
});

test('开场白：config.opening 覆盖人设默认并模板直出', async () => {
  const { engine } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  engine.updateConfig({ opening: '大家好，我是新人主播小夏，今天聊聊穿搭。' });
  const cold = await engine.tick({ force_cold_start: true });
  assert.match(cold.dialogue.text, /小夏/);
  assert.equal(cold.dialogue.source, 'template');
});
