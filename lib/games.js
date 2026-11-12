'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * S1 数字人陪玩 · 直播间小游戏引擎（回合制悬念类，弹幕即手柄）：
 *  1) number_bomb 数字炸弹：1-100 暗定炸弹数，弹幕报数收窄区间，报中炸弹者"引爆"；
 *  2) cut_wire   拆弹剪线：五根线一根雷，弹幕"剪红线/剪3"轮流剪，剪中雷当场爆炸。
 * 送礼玩法：游戏中送出中档及以上礼物 = 向主播"买情报"（排除区间/透露一根安全线），
 * 既有送礼钩子又推进游戏。输赢结算接既有礼物特效（爆炸/惩罚走具名模板）。
 * 全部只说"积分/输赢"，规避赌博表述；结果由服务端裁决，主播台词模板+TTS直出（不走LLM，保证节奏）。
 */

const GAMES = [
  { id: 'number_bomb', name: '数字炸弹', hint: '弹幕直接报 1-100 的数字，区间越缩越小，报中炸弹的人"引爆"' },
  { id: 'cut_wire', name: '拆弹剪线', hint: '弹幕发"剪红线/剪蓝色/剪3"来剪线，五根线一根雷，剪中雷当场爆炸' },
];

const WIRE_NAMES = ['红线', '蓝线', '绿线', '黄线', '白线'];
const WIRE_ALIASES = { 红: 0, 蓝: 1, 绿: 2, 黄: 3, 白: 4, '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };

function createGames(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const file = path.join(dataDir, 'games.json');
  const rng = options.rng || Math.random;
  const now = options.now || (() => Date.now());
  let state = { active: null, history: [] };
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && typeof saved === 'object') state = { active: saved.active || null, history: Array.isArray(saved.history) ? saved.history.slice(-20) : [] };
    } catch { /* 损坏则重建 */ }
  }
  // 运行期缓存（不落盘的随机底）：炸弹数字/雷线位置存内存，重启即作废重开
  const secrets = { bomb: null, wire: null };

  const persist = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...state, active: state.active ? { ...state.active, ...publicSecrets() } : null }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  function publicSecrets() {
    // 落盘只存裁决所需（供排查），不回传前端
    return { bomb: secrets.bomb, wire: secrets.wire };
  }
  function record(entry) {
    state.history.unshift({ id: `gm-${crypto.randomBytes(4).toString('hex')}`, at: new Date().toISOString(), ...entry });
    state.history = state.history.slice(0, 20);
  }
  function endGame(outcome, speech) {
    const game = state.active;
    state.active = null;
    secrets.bomb = secrets.wire = null;
    record({ event: 'end', game: game?.game, outcome });
    persist();
    return { ended: true, outcome, speech };
  }

  function status() {
    return {
      supported: GAMES,
      active: state.active ? { ...state.active } : null,
      history: state.history.slice(0, 10),
    };
  }

  /** 开局：返回主播口播的开场词（模板直出） */
  function start(gameId) {
    if (!GAMES.some(game => game.id === gameId)) throw Object.assign(new Error(`未知游戏：${gameId}（可用：${GAMES.map(g => g.id).join('/')}）`), { status: 400 });
    if (state.active) throw Object.assign(new Error(`已有进行中的游戏「${state.active.name}」，请先结束`), { status: 409 });
    if (gameId === 'number_bomb') {
      secrets.bomb = 1 + Math.floor(rng() * 100);
      state.active = { game: gameId, name: '数字炸弹', low: 1, high: 100, guesses: 0, started_at: new Date().toISOString() };
      record({ event: 'start', game: gameId });
      persist();
      return { game: gameId, speech: '来玩数字炸弹！我心里定了一个 1 到 100 的数字，它就是炸弹。弹幕直接报数字，区间会越缩越小，谁报中炸弹谁就"引爆"——游戏过程中给我送个中档以上礼物，我可以透露半个区间给你。来，报数！' };
    }
    secrets.wire = Math.floor(rng() * WIRE_NAMES.length);
    state.active = { game: gameId, name: '拆弹剪线', cut: [], started_at: new Date().toISOString() };
    record({ event: 'start', game: gameId });
    persist();
    return { game: gameId, speech: '拆弹剪线开始！我面前有红、蓝、绿、黄、白五根线，只有一根连着雷。弹幕发"剪红线"这样的口令来剪，剪中安全线大家加分，剪中雷——当场爆炸！想稳妥点，送个中档以上礼物，我偷偷告诉你一根安全线。谁先来？' };
  }

  /** 结束局：返回收尾词 */
  function stop(reason = '手动结束') {
    if (!state.active) return { ended: true, speech: '' };
    return endGame('stopped', `这局${state.active.name}先到这里（${reason}），想玩随时喊我，下一局更刺激。`);
  }

  /** 弹幕参与：命中游戏口令返回 {speech, actions, punishment_fx?}；未命中返回 null（走普通互动） */
  function handleComment(text) {
    const active = state.active;
    if (!active) return null;
    const value = String(text || '').trim();
    if (active.game === 'number_bomb') return handleBombComment(value);
    if (active.game === 'cut_wire') return handleWireComment(value);
    return null;
  }

  function handleBombComment(value) {
    const num = value.match(/\b(\d{1,3})\b/)?.[1];
    if (num === undefined) {
      if (/炸弹|数字|游戏|玩/.test(value)) return { speech: '直接在弹幕里报一个 1 到 100 的数字就行，报得越刁钻越刺激！', actions: [] };
      return null;
    }
    const guess = Number(num);
    if (!Number.isInteger(guess) || guess < 1 || guess > 100) return null;
    if (guess < state.active.low || guess > state.active.high) {
      return { speech: `${guess} 已经不在 ${state.active.low} 到 ${state.active.high} 的区间里啦，认真一点，报区间内的数！`, actions: [] };
    }
    state.active.guesses++;
    if (guess === secrets.bomb) {
      const speech = `轰——！${guess} 就是炸弹！这位家人把自己送上天了，全场安全，游戏结束！想报复仇局的弹幕扣"再来一局"。`;
      const result = endGame('bomb_hit', speech);
      return { speech: result.speech, actions: [], punishment_fx: 'boxing_punch', result };
    }
    if (guess < secrets.bomb) state.active.low = guess + 1;
    else state.active.high = guess - 1;
    persist();
    if (state.active.high - state.active.low <= 2) {
      return { speech: `${guess}——安全！区间只剩 ${state.active.low} 到 ${state.active.high} 了，躲在里面的那位，心跳是不是已经到嗓子了？继续报！`, actions: [] };
    }
    return { speech: `${guess}——安全！炸弹在 ${state.active.low} 到 ${state.active.high} 之间，区间越来越小了，下一个报数的家人想清楚！`, actions: [] };
  }

  function handleWireComment(value) {
    const hit = value.match(/剪\s*([红蓝绿黄白12345])/);
    if (!hit) {
      if (/剪|线|炸弹|游戏|玩|怎么/.test(value)) return { speech: '口令是"剪红线""剪蓝色"这样的格式，五根线任选一根，胆子大点！', actions: [] };
      return null;
    }
    const index = WIRE_ALIASES[hit[1]];
    if (state.active.cut.includes(index)) return { speech: `${WIRE_NAMES[index]}已经剪过了，换一根！剩下的线才藏着故事。`, actions: [] };
    state.active.cut.push(index);
    if (index === secrets.wire) {
      const speech = `咔嚓——轰！！${WIRE_NAMES[index]}就是那根雷！这位家人光荣"牺牲"，全场起立！想报仇的弹幕扣"再来一局"。`;
      const result = endGame('bomb_cut', speech);
      return { speech: result.speech, actions: [], punishment_fx: 'cream_prank', result };
    }
    persist();
    const remain = WIRE_NAMES.filter((_, i) => !state.active.cut.includes(i));
    if (remain.length === 1) {
      const speech = `${WIRE_NAMES[index]}是安全的！只剩最后一根${remain[0]}……雷就在它身上，谁敢来剪这最后一剪？`;
      return { speech, actions: [] };
    }
    return { speech: `咔嚓，${WIRE_NAMES[index]}安全！还剩 ${remain.length} 根：${remain.join('、')}，其中一根是雷，继续剪！`, actions: [] };
  }

  /** 送礼玩法：中档及以上礼物买情报（推进游戏 + 主播专属口播） */
  function giftHint(tier) {
    const active = state.active;
    if (!active || tier === 'low') return null;
    if (active.game === 'number_bomb') {
      const mid = Math.floor((active.low + active.high) / 2);
      if (secrets.bomb <= mid) { active.high = mid; return { speech: '谢谢这份心意！情报来了：炸弹不在下半区间——它就藏在新区间的上半段，机不可失！', hint: { side: 'upper' } }; }
      active.low = mid + 1; return { speech: '谢谢这份心意！情报来了：炸弹不在上半区间——它就在新区间的下半段，冲！', hint: { side: 'lower' } };
    }
    const safe = [...WIRE_NAMES.keys()].filter(i => i !== secrets.wire && !active.cut.includes(i));
    if (!safe.length) return null;
    const pick = safe[Math.floor(rng() * safe.length)];
    return { speech: `谢谢这份心意！偷偷告诉你：${WIRE_NAMES[pick]}绝对是安全的，别剪它，情报就值这一次！`, hint: { safe: WIRE_NAMES[pick] } };
  }

  return { status, start, stop, handleComment, giftHint, GAMES, WIRE_NAMES };
}

module.exports = { createGames, GAMES, WIRE_NAMES };
