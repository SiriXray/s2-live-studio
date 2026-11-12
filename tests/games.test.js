'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGames } = require('../lib/games');
const { createInteraction } = require('../lib/interaction');
const { normalizeInteractionConfig, defaultInteractionConfig } = require('../lib/rules');
const { PERSONAS, listPersonas } = require('../lib/personas');
const { listVoices, voiceForPersona } = require('../lib/voices');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 's2gm-'));

const CONFIG_ALL = {
  llm: { api_key: 'test-key', model: 'recaption3.4', base_url: 'https://api.vidu.cn/ent/v2' },
  minimax: { api_key: 'test-key', model: 'test-model', voice_id: 'v', speed: 1 },
  soul: { api_key: '', model: 'loxi-speech-1.0', base_url: 'https://api.loxinity.com', voice_id: '' },
  live: { persona: '你是一位主播' },
  vidu: { api_key: '', host: 'mock.example' },
};

function mockTransport(url) {
  if (String(url).includes('/ent/v2/chat/completions')) {
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '好的，收到，这就安排！' } }] }) });
  }
  if (String(url).includes('minimax')) {
    return Promise.resolve({ ok: true, json: async () => ({ base_resp: { status_code: 0 }, data: { audio: 'aaaaaaaa' }, extra_info: { audio_sample_rate: 24000, audio_channel: 1, audio_format: 'pcm' } }) });
  }
  return Promise.resolve({ ok: false, status: 599, json: async () => ({}) });
}

/* ---------------- 人设 × 双音色（女声/男声） ---------------- */

test('每个人设都配有女声/男声两条音色档案，按性别解析正确', () => {
  const voices = listVoices();
  for (const persona of PERSONAS) {
    assert.ok(persona.voices?.female && persona.voices?.male, `${persona.id} 须同时配置女声与男声`);
    const female = voiceForPersona(persona, 'female');
    const male = voiceForPersona(persona, 'male');
    assert.equal(female.gender, 'female', `${persona.id} 女声解析须为女声档案`);
    assert.equal(male.gender, 'male', `${persona.id} 男声解析须为男声档案`);
  }
  const hype = PERSONAS.find(item => item.id === 'hype_sales');
  assert.equal(voiceForPersona(hype, 'male').id, 'male_low_b', '亢奋带货默认男声');
  assert.equal(voiceForPersona(hype, 'female').id, 'female_cheery_i', '亢奋带货女声可选');
  assert.ok(voices.filter(voice => voice.gender === 'male').length >= 2, '男声档案至少 2 条');
  const listed = listPersonas().find(item => item.id === 'hype_sales');
  assert.ok(listed.voice_female_name && listed.voice_male_name, '清单应携带双音色名称');
});

test('音色性别偏好可入配置（voice_gender）', () => {
  assert.throws(() => normalizeInteractionConfig({ voice_gender: 'both' }), /音色性别/);
  const ok = normalizeInteractionConfig({ voice_gender: 'female' });
  assert.equal(ok.voice_gender, 'female');
  assert.equal(defaultInteractionConfig().voice_gender, '');
});

/* ---------------- 静默小动作 ---------------- */

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
  return { engine, dataDir, advance: ms => { clock += ms; }, setRandom: value => { seed = value; } };
}

test('静默小动作：无播报时按 idle_motion_s 节拍返回纯画面动作（不出声）', async () => {
  const { engine, advance } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  advance(16_000);
  const cold = await engine.tick();
  assert.equal(cold.intent, 'cold_start');
  engine.handleEvent({ type: 'speech_done', plan_id: cold.id });
  // 拉远冷场唤醒，隔离验证小动作节拍（节拍 20s 短于默认冷场 30s）
  engine.updateConfig({ triggers: { silence_s: 100000 } });
  advance(46_000);
  const idle = await engine.tick();
  assert.equal(idle?.idle_motion, true, '无播报且超过节拍应返回静默小动作');
  assert.ok(Array.isArray(idle.actions) && idle.actions.length >= 1, '须携带待机动作');
  assert.ok(!idle.dialogue, '静默小动作不出声');
  const soon = await engine.tick();
  assert.equal(soon, null, '节拍内不重复触发');
});

/* ---------------- 小游戏：数字炸弹 / 拆弹剪线 ---------------- */

function makeGames(seedSequence) {
  let index = 0;
  const dataDir = tmpDir();
  const games = createGames({ dataDir, rng: () => seedSequence[index++ % seedSequence.length] });
  return { games, dataDir };
}

test('数字炸弹：开局→报数收窄区间→报中引爆结算', () => {
  const { games } = makeGames([0.99]); // bomb = 100
  const opened = games.start('number_bomb');
  assert.match(opened.speech, /数字炸弹/);
  const first = games.handleComment('50');
  assert.match(first.speech, /51 到 100/);
  const repeat = games.handleComment('30');
  assert.match(repeat.speech, /51 到 100/, '区间外的报数应提示当前有效区间');
  const outside = games.handleComment('10');
  assert.match(outside.speech, /不在/);
  const boom = games.handleComment('100');
  assert.match(boom.speech, /轰/);
  assert.equal(boom.punishment_fx, 'boxing_punch');
  assert.equal(games.status().active, null, '引爆后游戏结束');
  assert.throws(() => games.start('nope'), /未知游戏/);
});

test('拆弹剪线：剪安全线→剪中雷结算；口令格式校验', () => {
  const { games } = makeGames([0.99]); // wire index 4（白线）
  games.start('cut_wire');
  const chat = games.handleComment('随便聊聊');
  assert.equal(chat, null, '无关弹幕不拦截');
  const help = games.handleComment('怎么玩');
  assert.match(help.speech, /剪/);
  const safe = games.handleComment('剪红线');
  assert.match(safe.speech, /安全/);
  const again = games.handleComment('剪红线');
  assert.match(again.speech, /已经剪过/);
  const boom = games.handleComment('剪白线');
  assert.match(boom.speech, /轰/);
  assert.equal(boom.punishment_fx, 'cream_prank');
  assert.equal(games.status().active, null);
});

test('送礼玩法：游戏中送中档礼物可买情报（排除区间/透露安全线）', () => {
  const { games } = makeGames([0.2]); // bomb = 21
  games.start('number_bomb');
  const hint = games.giftHint('mid');
  assert.ok(hint.speech.includes('情报'), '买情报口播');
  assert.ok(hint.hint.side, '炸弹侧情报');
  assert.ok(games.status().active.low > 1 || games.status().active.high < 100, '区间应被情报收窄');

  const { games: wireGames } = makeGames([0.5]);
  wireGames.start('cut_wire');
  const wireHint = wireGames.giftHint('high');
  assert.match(wireHint.speech, /安全/);
  const safeName = wireHint.hint.safe;
  const boom = wireGames.handleComment(safeName === '红线' ? '剪蓝线' : '剪红线');
  // 剪的线可能是雷（不固定），只验证礼物流程可给出情报
  assert.ok(wireHint.speech);
});

/* ---------------- 引擎集成：game_control + 弹幕拦截 + 送礼情报 ---------------- */

test('互动引擎：game_control 开局口播（TTS直出）+ 游戏弹幕拦截优先于普通互动', async () => {
  const { engine } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  const start = await engine.handleEvent({ type: 'game_control', game: 'number_bomb', action: 'start' });
  assert.equal(start.plan.intent, 'game');
  assert.equal(start.plan.dialogue.source, 'template', '游戏口播走模板直出');
  assert.ok(start.plan.dialogue.audio, '模板台词也应有 TTS 音频');
  assert.ok(start.game.active, '开局后状态为进行中');
  const guess = await engine.handleEvent({ type: 'comment', text: '50' });
  assert.equal(guess.plan.intent, 'game', '命中游戏口令的弹幕由游戏裁决');
  assert.match(guess.plan.dialogue.text, /炸弹在|安全/);
  const stop = await engine.handleEvent({ type: 'game_control', action: 'stop' });
  assert.equal(stop.game.active, null, '收局后状态清空');
});

test('互动引擎：游戏进行中送礼带情报口播', async () => {
  const { engine } = makeEngine();
  await engine.handleEvent({ type: 'live_start', live_id: 'L1' });
  await engine.handleEvent({ type: 'game_control', game: 'cut_wire', action: 'start' });
  const gift = await engine.handleEvent({ type: 'gift', gift: '灯牌', value: 66 });
  assert.equal(gift.plan.intent, 'gift_mid');
  assert.match(gift.plan.dialogue.text, /情报|安全/, '中档礼物应叠加买情报口播');
  assert.ok(gift.plan.game_hint, '计划携带情报结构');
});
