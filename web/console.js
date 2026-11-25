/**
 * V2 互动组合策略中控台：右侧抽屉。
 * 职责：人设/唤醒/档位配置 → /api/interaction/config；
 *      事件模拟（弹幕/礼物/PK）→ /api/interaction/event；
 *      时间触发轮询 → /api/interaction/tick；
 *      双轨执行：对话轨（speakOut）与画面轨（动作/Editing换装/舞蹈任务覆盖层）并行。
 */
const bridge = window.S2Bridge;
import { sendPcm } from './audio.js';
const element = id => document.getElementById(id);
const TIER_BADGE = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4', 5: 'P5' };
let manifest = null;
let executing = null; // { abort, priority, planId }
let lastSpokenAt = Date.now();
let fallbackBusy = false;
let suyuScriptPlaying = false;
let playbackToken = 0;
function interruptCurrentPlayback() {
  playbackToken++;
  if (executing) {
    try { executing.abort.abort(); } catch {}
    executing = null;
  }
  try { bridge?.interrupt?.(); } catch {}
  window.SALES_SCRIPT_RUNNING = false;
}
const FALLBACK_CHAT_LINES = {
  entertainment: [
    '家人们，刚进来的先把关注点上，点关注不迷路。',
    '今天这场我准备了好几个整活，你们想先看哪一个？',
    '弹幕别停，我看到有意思的会直接接。',
    '觉得今天状态不错的，公屏扣个1让我看看。',
    '礼物不用刷，陪我聊会儿也是支持。',
    '你们最近刷到什么好玩的视频？分享一个给我。',
    '我先自己嗨一会儿，你们负责笑就行。',
    '直播间人不多也没关系，我把你们一个个记住。',
  ],
  education: [
    '宝宝们，今天这套穿搭的重点在腰线，不是越紧越显瘦。',
    '选裙子先看面料垂感，再看颜色，最后才看款式。',
    '小个子可以把上衣塞一点进腰头，比例会立刻不一样。',
    '微胖女生别怕浅色，关键是版型和露肤的位置。',
    '梨形身材重点遮胯，A字裙比紧身包臀更稳。',
    '今天这套是正面和侧面都能看的，我转一下你们对比。',
    '有宝宝问链接，我先讲清楚适不适合，再给你们找。',
    '穿搭不是把自己藏起来，是把优点放到镜头前面。',
  ],
  lifestyle: [
    '今天上海天气有点凉，你们那边呢？出门记得带件外套。',
    '我最近在读一本很慢的书，翻得很慢，反而舍不得读完。',
    '前几天看到一幅颜色淡淡的画，会让人安静下来。',
    '今天突然想吃火锅，但一个人吃又觉得少了点什么。',
    '如果来上海玩，武康路拍照好看，外滩夜景也值得去。',
    '有人去过环球影城吗？排队久，但沉浸感真的很强。',
    '晚上容易饿，你们有没有低负担的宵夜推荐？',
    '我心情不好的时候会洗个热水澡，你们呢？',
  ],
};
let fallbackUsed = new Set();
let lastFallbackLine = '';
function fallbackPool() {
  const persona = document.getElementById('showroomPersona')?.value || '';
  if (['suyu', 'gaoxiao', 'susu'].includes(persona)) return FALLBACK_CHAT_LINES.entertainment;
  if (['xiaomei', 'knowledge', 'teacher'].includes(persona)) return FALLBACK_CHAT_LINES.education;
  return FALLBACK_CHAT_LINES.lifestyle;
}
function pickFallbackLine() {
  const pool = fallbackPool();
  let fresh = pool.filter(line => line !== lastFallbackLine && !fallbackUsed.has(line));
  if (!fresh.length) {
    fallbackUsed.clear();
    fresh = pool.filter(line => line !== lastFallbackLine);
  }
  if (!fresh.length) fresh = pool;
  const line = fresh[Math.floor(Math.random() * fresh.length)];
  fallbackUsed.add(line);
  lastFallbackLine = line;
  return line;
}
let voices = [];      // 音色档案（/api/config.voices）
let singing = null;   // { abort, session } 实时唱歌会话
let mvTask = null;    // 最近一次 MV 任务 { task_id, url, state }
let s2 = null;        // S2 组件版自然度参数（GET /api/s2/params）
let s2Meta = null;    // 预设 / 参数说明 / 取值范围
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function toast(message, error = false) { bridge?.toast ? bridge.toast(message, error) : alert(message); }
function log(message) { bridge?.log ? bridge.log(message) : console.log(message); }

async function api(resource, body, options = {}) {
  const response = await fetch(resource, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 HTTP ${response.status}`);
  return result;
}

function openDrawer(open) {
  element('consoleDrawer').hidden = !open;
  element('consoleButton').setAttribute('aria-pressed', String(open));
  // 抽屉开启时，麦克风语音与聊天框都改走互动引擎（意图分类+双轨输出）
  window.__consoleActive = open;
  window.__consoleDispatch = open ? dispatchPlan : null;
  if (open) { renderManifest(); refreshFeed(); renderVoiceCard(); loadS2(); setTimeout(loadGames, 0); }
}

async function dispatchPlan(plan) {
  if (plan?.trigger) feed(`语音/聊天 → ${plan.trigger}（P${plan.priority}）→ 双轨执行`);
  if (plan) await executePlan(plan);
}

function renderManifest() {
  const data = manifest;
  const list = element('personaList');
  list.replaceChildren();
  for (const persona of data.personas) {
    const card = document.createElement('button');
    card.className = `persona-card${data.config.persona_id === persona.id ? ' selected' : ''}`;
    card.innerHTML = `<b>${persona.name}</b><small>女声：${persona.voice_female_name || '—'} · 男声：${persona.voice_male_name || '—'}</small><small>形象独立于「形象与换装」，不随人设切换</small>`;
    card.onclick = async () => {
      try {
        manifest = await api('/api/interaction/config', { persona_id: persona.id });
        renderManifest();
        renderVoiceCard();
        feed(`人设已切换：${persona.name}（女声：${persona.voice_female_name || '—'} / 男声：${persona.voice_male_name || '—'}）`);
        toast(`已切换：${persona.name}`);
      }
      catch (error) { toast(error.message, true); }
    };
    list.appendChild(card);
  }
  element('cfgCold').value = data.config.triggers.cold_start_delay_s;
  element('cfgSilence').value = data.config.triggers.silence_s;
  element('cfgTalent').value = data.config.triggers.talent_anchor_min;
  element('cfgVote').value = data.config.triggers.pk_vote_interval_s;
  element('cfgChat').value = data.config.triggers.smalltalk_probability;
  element('cfgIdle').value = data.config.triggers.idle_motion_s;
  element('openingText').value = data.config.opening || '';
  const tiers = Object.fromEntries(data.config.gift_tiers.map(tier => [tier.id, tier]));
  element('tierLowMax').value = tiers.low?.max ?? 10;
  element('tierMidMax').value = tiers.mid?.max ?? 100;
  const matrix = element('intentMatrix');
  matrix.replaceChildren();
  for (const intent of data.config.intents) {
    const row = document.createElement('div');
    row.className = `intent-row tier-${intent.tier}`;
    row.innerHTML = `<span class="tier-badge">${TIER_BADGE[intent.tier]}</span><div><b>${intent.name}</b><small>${intent.examples.join('、')} → ${intent.handling}</small></div>`;
    matrix.appendChild(row);
  }
}

async function saveTriggers() {
  try {
    manifest = await api('/api/interaction/config', { triggers: {
      cold_start_delay_s: Number(element('cfgCold').value),
      silence_s: Number(element('cfgSilence').value),
      talent_anchor_min: Number(element('cfgTalent').value),
      pk_vote_interval_s: Number(element('cfgVote').value),
      smalltalk_probability: Number(element('cfgChat').value),
      idle_motion_s: Number(element('cfgIdle').value),
    } });
    toast('唤醒参数已保存');
  } catch (error) { toast(error.message, true); }
}

async function saveOpening() {
  try {
    manifest = await api('/api/interaction/config', { opening: element('openingText').value });
    toast(manifest.config?.opening ? '开场白已保存，下次冷启动生效' : '已恢复人设默认开场白');
  } catch (error) { toast(error.message, true); }
}

async function saveTiers() {
  const lowMax = Number(element('tierLowMax').value);
  const midMax = Number(element('tierMidMax').value);
  try {
    manifest = await api('/api/interaction/config', { gift_tiers: [
      { max: lowMax },
      { min: lowMax + 1, max: midMax },
      { min: midMax + 1 },
    ] });
    toast('礼物档位已保存');
  } catch (error) { toast(error.message, true); }
}

function feed(message, level = '') {
  const row = document.createElement('div');
  row.className = `feed-row${level === 'err' ? ' err' : ''}${level === 'ok' ? ' ok' : ''}`;
  row.textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${message}`;
  element('consoleFeed').prepend(row);
  while (element('consoleFeed').children.length > 60) element('consoleFeed').lastElementChild.remove();
}

async function refreshFeed() {
  try {
    const data = await api('/api/interaction/log');
    const badge = element('phaseBadge');
    const phase = data.state.phase;
    badge.textContent = phase === 'pk' ? 'PK 中' : phase === 'live' ? '直播中' : '待机';
    badge.className = `tag phase-${phase}`;
    for (const entry of data.audit.slice(0, 12)) {
      if (element('consoleFeed').querySelector(`[data-id="${entry.id}"]`)) break;
      const row = document.createElement('div');
      row.dataset.id = entry.id;
      row.className = 'feed-row';
      row.textContent = `${new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}  ${entry.type} · ${entry.detail || entry.text || entry.reason || ''}`;
      element('consoleFeed').appendChild(row);
    }
  } catch { /* 静默重试 */ }
}

/* ---------- 双轨执行 ---------- */

function playFullTransition(url) {
  const stage = element('stageLive') || element('stage');
  if (!stage || !url) return;
  stage.querySelector('.transition-overlay')?.remove();
  const video = document.createElement('video');
  video.className = 'stage-overlay full transition-overlay';
  video.src = url;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('aria-hidden', 'true');
  video.style.objectFit = 'cover';
  stage.appendChild(video);
  const remove = () => video.remove();
  video.onended = remove;
  video.onerror = () => { remove(); feed('转场视频全屏预览失败，继续走 S2 转场', 'err'); };
  setTimeout(remove, 20000);
  feed('转场 · 人物转场视频全屏播放（cover 填满舞台）');
}

/* 特效/礼物视频：填满舞台下半屏（cover 裁切不变形）；full=true 整屏（图生视频 Q4 / 已生成成片） */
function playOverlay(url, full = false) {
  const stage = element('stageLive') || element('stage');
  let overlay = stage.querySelector('.stage-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('video');
  overlay.className = full ? 'stage-overlay full' : 'stage-overlay';
  overlay.src = url;
  overlay.autoplay = true;
  overlay.playsInline = true;
  stage.appendChild(overlay);
  overlay.onended = () => overlay.remove();
  overlay.onerror = () => { overlay.remove(); feed('才艺/特效视频播放失败', 'err'); };
}

async function executeVisual(commands) {
  for (const command of commands || []) {
    if (command.kind === 'action') {
      // 动作先于 PCM 发送（与录制链路一致），避免 type 9 在说话中途触发动作导致卡顿；
      // 实时版 type 101 才适合边说话边发，默认组件版仍然先发动作。
      const delay = Number.isFinite(command.delay_ms) ? Math.max(0, command.delay_ms) : 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      for (const name of command.actions || []) {
        if (bridge.sendAction(name, { intensity: command.intensity, protocol: command.protocol })) {
          feed(`画面轨 · 动作已发送：${name}（+${delay}ms）`);
        } else feed(`画面轨 · 动作发送失败：${name}`, 'err');
      }
      // 不在这里 await 或打日志：动作的“回落/归位”由动作库描述完成，
      // 阻塞/噪声会影响下一轮弹幕调度；这里只负责把动作尽早发出。
    } else if (command.kind === 'dress') {
      const image = await bridge.referenceImage();
      if (image && bridge.editingReady() && bridge.switchPrompt(image, command.editing_type)) {
        feed(`画面轨 · Editing switch_prompt 已发送（${command.editing_type}），效果待人工确认`);
      } else {
        feed(`画面轨 · 换装降级：未开启Editing或未选参考图。PRD风险提示：换装建议使用完整人物照重开会话，直播中换背景可能把衣服画走样`, 'err');
      }
    } else if (command.kind === 'dance' || command.kind === 'effect') {
      try {
        const image = await bridge.avatarImage();
        if (!image) { feed('画面轨 · 未选择主播形象，无法发起才艺/特效任务', 'err'); continue; }
        const task = await api('/api/effect/dance', { kind: command.kind, template: command.template, fx: command.fx, real: command.real, image_uri: image });
        if (task.state === 'dry_run') feed(`画面轨 · ${command.kind === 'dance' ? '才艺舞蹈' : '特效'}演练：template=${task.payload.template}，未产生费用（dry_run）`);
        else {
          feed(`画面轨 · ${command.kind === 'dance' ? '才艺舞蹈' : '特效'}任务已创建：${task.task_id}`);
          pollEffect(task.task_id);
        }
      } catch (error) { feed(`画面轨 · 才艺/特效失败：${error.message}`, 'err'); }
    }
  }
}

async function pollEffect(taskId, attempt = 0, full = false) {
  if (attempt > 60) return;
  try {
    const task = await api(`/api/effect/task/${taskId}`);
    if (task.state === 'success' && task.url) {
      if (singing) {
        // 演唱中特效视频的音轨会与歌声抢音频时间轴，等演唱结束再播
        feed('画面轨 · 特效已生成，等演唱结束后播放', 'ok');
        const wait = setInterval(() => { if (!singing) { clearInterval(wait); playOverlay(task.url, full); } }, 5000);
        return;
      }
      feed('画面轨 · 生成完成，开始覆盖播放', 'ok');
      playOverlay(task.url, full);
      return;
    }
    if (task.state === 'failed') { feed(`画面轨 · 生成失败：${taskId}`, 'err'); return; }
    if (task.state !== 'dry_run') setTimeout(() => pollEffect(taskId, attempt + 1), 5000);
  } catch (error) { feed(`画面轨 · 任务查询失败：${error.message}`, 'err'); }
}

async function executePlan(plan) {
  const priority = plan.priority ?? 3;
  lastSpokenAt = Date.now();
  // 礼物到达：先叠一层即时礼物动效（零延迟），礼物特效任务在后台真实生成（绕过 dry_run），完成后覆盖播放
  if (String(plan.intent || '').startsWith('gift')) {
    bridge.giftOverlay?.(plan.gift?.name, plan.gift?.tier);
    if (plan.gift?.tier && plan.gift.tier !== 'low') triggerGiftFx(plan.gift.name);
  }
  // 唱歌占用唯一音频轨：演唱中不插话不互动（TTS 与歌声并行写入 S2 sendPcm 会争抢播放时间轴导致卡顿），礼物只保留画面动效
  if (singing) {
    feed(`唱歌中 · 「${plan.trigger || plan.intent}」暂不互动，歌声独占音频轨（礼物动效已照常叠加）`);
    return plan;
  }
  if (executing && priority <= 2 && executing.priority > priority) {
    feed(`对话轨 · P${priority}「${plan.trigger}」打断当前播报（优先级插队）`);
    executing.abort.abort();
    executing = null;
  } else if (executing) {
    feed(`对话轨 · 调度器判定本轮不插队，丢弃/排队（P${priority}）`, 'err');
    return;
  }
  const abort = new AbortController();
  executing = { abort, priority, planId: plan.id };
  fetch('/api/interaction/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'speech_started', plan_id: plan.id, tier: priority }) }).catch(() => {});
  const visualTask = executeVisual(plan.visual).catch(error => {
    if (error.name !== 'AbortError') feed(`画面轨失败（对话轨继续）：${error.message}`, 'err');
  });
  try {
    bridge.addMessage?.('assistant', `[${plan.persona_name}] ${plan.dialogue.speech_text || plan.dialogue.text}`);
    try {
      if (plan.dialogue.audio) {
        if (bridge.isReady()) await bridge.speakOut(plan.dialogue.text, plan.dialogue.audio, plan.dialogue.speech_text);
        else { feed('对话轨 · 直播未连接，仅文本+画面轨演练'); await playLocal(plan.dialogue.audio); }
      }
    } catch (error) {
      // 对话轨失败不拖死画面轨：礼物特效/动作照常执行
      if (error.name !== 'AbortError') feed(`对话轨失败（画面轨继续）：${error.message}`, 'err');
    }
    await visualTask;
    feed(`对话轨完成 · ${plan.trigger} · 来源：${plan.dialogue.source}`);
  } catch (error) {
    if (error.name !== 'AbortError') { feed(`执行失败：${error.message}`, 'err'); toast(error.message, true); }
  } finally {
    await visualTask.catch(() => {});
    if (executing?.abort === abort) executing = null;
    fetch('/api/interaction/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'speech_done', plan_id: plan.id }) }).catch(() => {});
  }
}

async function playLocal(audioBase64) {
  const bytes = Uint8Array.from(atob(audioBase64), char => char.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const view = new DataView(buffer);
  const sampleRate = 24000;
  const wav = new ArrayBuffer(44 + bytes.length);
  const wavView = new DataView(wav);
  const writeStr = (offset, text) => { for (let i = 0; i < text.length; i++) wavView.setUint8(offset + i, text.charCodeAt(i)); };
  writeStr(0, 'RIFF'); wavView.setUint32(4, 36 + bytes.length, true); writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
  wavView.setUint32(16, 16, true); wavView.setUint16(20, 1, true); wavView.setUint16(22, 1, true);
  wavView.setUint32(24, sampleRate, true); wavView.setUint32(28, sampleRate * 2, true);
  wavView.setUint16(32, 2, true); wavView.setUint16(34, 16, true); writeStr(36, 'data');
  wavView.setUint32(40, bytes.length, true);
  new Uint8Array(wav, 44).set(bytes);
  void view;
  const audio = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
  await audio.play().catch(() => {});
}

/* ---------- 音色档案（Soul 主链路 · 女/男双下拉） ---------- */

/** 填充单个性别下拉；当前生效音色在该性别下拉中选中 */
function fillVoiceSelect(select, genderVoices, activeId) {
  select.replaceChildren();
  for (const voice of genderVoices) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.name;
    option.dataset.soul = voice.soul;
    option.dataset.minimax = voice.minimax;
    select.appendChild(option);
  }
  if (genderVoices.some(voice => voice.id === activeId)) select.value = activeId;
}

async function renderVoiceCard() {
  try {
    const config = await api('/api/config');
    voices = config.voices || [];
    const active = voices.find(voice => voice.id === config.active_voice) || voices[0];
    fillVoiceSelect(element('voiceFemaleSelect'), voices.filter(voice => voice.gender === 'female'), active?.gender === 'female' ? active.id : undefined);
    fillVoiceSelect(element('voiceMaleSelect'), voices.filter(voice => voice.gender === 'male'), active?.gender === 'male' ? active.id : undefined);
    syncVoiceHint();
  } catch (error) { feed(`音色档案加载失败：${error.message}`, 'err'); }
}

function syncVoiceHint() {
  for (const id of ['voiceFemaleSelect', 'voiceMaleSelect']) {
    const select = element(id);
    const option = select.selectedOptions[0];
    // 提示语收敛为悬浮提示，不再占用界面文字
    select.title = option ? `Soul ${option.dataset.soul} · 回落 ${option.dataset.minimax}` : '';
  }
}

/** 任一性别下拉变更即生效（挑女声=偏好女声，之后切人设也优先女声） */
async function applyVoice(selectId) {
  const id = element(selectId).value;
  const voice = voices.find(item => item.id === id);
  if (!voice) return;
  try {
    await api('/api/interaction/config', { voice_id: id });
    await renderVoiceCard();
    feed(`音色已切换：${voice.name}（Soul ${voice.soul}）`, 'ok');
    toast(`音色已切换：${voice.name}`);
  } catch (error) { toast(error.message, true); }
}

async function auditionVoice() {
  const female = element('voiceFemaleSelect');
  const male = element('voiceMaleSelect');
  const select = document.activeElement === male ? male : (document.activeElement === female ? female : (male.value && !female.value ? male : female));
  const id = select.value;
  const voice = voices.find(item => item.id === id);
  if (!voice) { toast('该性别暂无可选音色', true); return; }
  try {
    const result = await api('/api/voice/preview', { voice_id: id, text: '大家好，欢迎来到直播间，这是我的声音，喜欢就点点关注。' });
    if (result.audio) { await playLocal(result.audio); feed(`试听完成：${voice.name}（${result.provider}）`); }
    else feed(`试听失败：${result.error || '未返回音频'}`, 'err');
  } catch (error) { toast(error.message, true); }
}

/** 形象匹配音色：当前主播形象图 → DashScope VLM 识别性别气质 → 匹配档案 → 直接切换 */
async function detectVoiceFromAvatar() {
  const note = element('detectNote');
  try {
    element('detectVoice').disabled = true;
    note.textContent = '正在识别形象…';
    const image = await bridge.avatarImage();
    if (!image) { note.textContent = '请先选择主播形象图，再做形象匹配'; return; }
    feed('音色匹配 · 正在用 VLM 识别形象性别与气质…');
    const result = await api('/api/voice/detect', { image_uri: image, apply: true });
    if (!result.voice_id) {
      note.textContent = `识别结果：${result.gender === 'unknown' ? '性别不明确' : result.gender}（${result.reason || '无依据'}），请手动选择音色`;
      feed(`音色匹配 · ${result.note || '未匹配到音色档案'}`, 'err');
      return;
    }
    // 与服务端写入保持一致：刷新下拉并选中匹配档案
    await renderVoiceCard();
    const matchedSelect = result.gender === 'male' ? element('voiceMaleSelect') : element('voiceFemaleSelect');
    matchedSelect.value = result.voice_id;
    syncVoiceHint();
    note.hidden = false;
    note.textContent = `形象识别：${result.gender === 'male' ? '男' : '女'} · ${result.reason} → 已切换「${result.voice_name}」`;
    feed(`音色匹配 · 形象识别为${result.gender === 'male' ? '男' : '女'}性（${result.reason}）→ 自动切换 ${result.voice_name}`, 'ok');
    toast(`形象匹配音色：${result.voice_name}`);
  } catch (error) {
    note.hidden = true;
    toast(`形象匹配失败：${error.message}`, true);
  } finally { element('detectVoice').disabled = false; }
}

/* ---------- 唱歌：实时 PCM 口型驱动 ---------- */

/** mp3/wav → 24kHz 单声道 s16le PCM（浏览器解码，服务端零依赖） */
async function decodeMusicPcm(arrayBuffer) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await ctx.decodeAudioData(arrayBuffer); }
  finally { ctx.close().catch(() => {}); }
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 24000), 24000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const f32 = rendered.getChannelData(0);
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const sample = Math.max(-1, Math.min(1, f32[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return { pcm, duration: decoded.duration };
}

async function loadMusic() {
  try {
    const data = await api('/api/sing/music');
    const select = element('singMusic');
    select.replaceChildren();
    if (!data.items?.length) { const option = document.createElement('option'); option.textContent = data.note || '（音乐目录为空）'; option.disabled = true; select.appendChild(option); return; }
    for (const item of data.items) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = `${item.name.replace(/\.(mp3|wav|aac|m4a)$/i, '')} · ${(item.size / 1048576).toFixed(1)}MB`;
      select.appendChild(option);
    }
  } catch (error) { feed(`音乐库加载失败：${error.message}`, 'err'); }
}

async function startSinging() {
  const name = element('singMusic').value;
  if (!name) return;
  if (!bridge.liveActive()) { toast('请先开播并连接直播，再开始演唱', true); return; }
  if (singing) { toast('正在演唱中', true); return; }
  await beforePerformance('唱歌').catch(() => false);
  const abort = new AbortController();
  singing = { abort, name };
  element('singStart').disabled = true;
  element('singStop').disabled = false;
  const progress = element('singProgress');
  progress.hidden = false;
  progress.value = 0;
  try {
    feed(`唱歌 · 拉取《${name}》…`);
    const response = await fetch(`/api/sing/file?name=${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`音乐文件拉取失败 HTTP ${response.status}`);
    const { pcm, duration } = await decodeMusicPcm(await response.arrayBuffer());
    if (duration < 10 || duration > 300) throw new Error(`曲目时长 ${duration.toFixed(0)}s 超出 10–300 秒范围`);
    // 占用调度：tier=1，P0 礼物可打断；tick 唤醒暂停
    await api('/api/interaction/event', { type: 'speech_started', plan_id: `sing-${Date.now()}`, tier: 1 });
    const title = name.replace(/\.(mp3|wav|aac|m4a)$/i, '');
    bridge.stream()?.sendOutputText(`♪ 为大家带来一首《${title}》，喜欢这首歌的扣个 1`);
    feed(`唱歌 · 开唱《${title}》 ${duration.toFixed(0)}s（PCM 口型驱动，静音帧持续）`, 'ok');
    const SLICE = 24000 * 2 * 15; // 每次 15 秒
    let overshoot = 0; // 分片拼接的全局时间轴补偿（音画同步：分片间不留额外空隙）
    for (let offset = 0; offset < pcm.length && singing?.abort === abort; offset += SLICE) {
      const end = Math.min(offset + SLICE, pcm.length);
      const sliceStart = performance.now();
      await sendPcm(bridge.stream(), new Uint8Array(pcm.buffer, offset * 2, (end - offset) * 2), abort.signal, () => performance.now() - overshoot);
      overshoot += (performance.now() - sliceStart) - (end - offset) / 48;
      progress.value = Math.round(end / pcm.length * 100);
    }
    if (singing?.abort === abort) {
      const pad = Number(s2?.naturalness?.singing?.tail_pad_ms) || 0;
      if (pad > 0) { feed(`唱歌 · 收尾驻留 ${pad}ms，避免唱完抢拍`); await sleep(pad); }
      feed('唱歌 · 演唱完成，恢复互动调度', 'ok');
    }
  } catch (error) {
    if (error.name !== 'AbortError') { feed(`唱歌失败：${error.message}`, 'err'); toast(error.message, true); }
  } finally {
    if (singing?.abort === abort) singing = null;
    element('singStart').disabled = false;
    element('singStop').disabled = true;
    progress.hidden = true;
    api('/api/interaction/event', { type: 'speech_done', plan_id: 'sing-clear' }).catch(() => {});
  }
}

function stopSinging(reason = '手动停止') {
  if (!singing) return;
  singing.abort.abort();
  singing = null;
  bridge.stream()?.interrupt();
  element('singStart').disabled = false;
  element('singStop').disabled = true;
  element('singProgress').hidden = true;
  feed(`唱歌 · 已停止（${reason}），调度恢复`, 'err');
}

/* ---------- 唱歌/跳舞：一键 MV（离线路径） ---------- */

function mvNote(text) { const note = element('mvStatusHelp'); note.hidden = !text; note.textContent = text; }

/* MV 固定提示词：入参图 → 女主播形象（Vidu 一键 MV 支持 prompt 参数，可编辑覆盖） */
const MV_DEFAULT_PROMPT = '以参考图中的女主播形象为主角，保持容貌、发型与服装完全一致，作为娱乐女主播在 MV 镜头前演唱，多机位近景与中景交替剪辑，舞台灯光氛围感，画面质感高级';
function mvPromptText() { return element('mvPrompt').value.trim() || MV_DEFAULT_PROMPT; }

/* 引擎切换：MV Agent 1.0/2.0 显示模式 + 视频链接/提示词输入，Motion Sync 显示参考视频输入 */
function syncEngineUi() {
  const engine = element('danceEngine').value;
  const mvLike = engine === 'mv2' || engine === 'mv1';
  element('mvMode').hidden = !mvLike;
  element('motionRefRow').hidden = engine !== 'motion_sync';
  element('mvVideoRow').hidden = !mvLike;
  element('mvPromptRow').hidden = !mvLike;
  if (mvLike && !element('mvPrompt').value) element('mvPrompt').value = MV_DEFAULT_PROMPT;
}

/** 引擎统一入口：mv2/mv1 → 一键 MV（默认当前 S2 形象图）；motion_control → 模板跳舞；motion_sync → image2dance */
async function createMv() {
  const engine = element('danceEngine').value;
  try {
    element('mvCreate').disabled = true;
    const image = await bridge.avatarImage();
    if (!image) throw new Error('未选择主播形象图（MV/跳舞默认用当前 S2 形象，与直播共用一套入参）');
    if (engine === 'motion_sync') {
      const videoUrl = element('motionRefVideo').value.trim();
      if (!videoUrl) throw new Error('Motion Sync 需要动作参考视频 URL（2-30 秒、宽高 ≤2048px）');
      mvNote('提交 Motion Sync（image2dance，约 10 积分/秒）…');
      /* 本地上传视频走 video_name（服务端直接读文件），公网链接走 video_url */
      const payload = uploadedVideo && videoUrl === uploadedVideo.url
        ? { image_uri: image, video_name: uploadedVideo.name }
        : { image_uri: image, video_url: videoUrl };
      const task = await api('/api/effect/motion-sync', payload);
      if (task.state === 'dry_run') { mvNote('演练模式：未调用真实接口、未产生费用'); feed('Motion Sync · 演练完成（dry_run）'); }
      else { mvNote(`Motion Sync 任务 ${task.task_id} 生成中…`); feed(`Motion Sync · 任务已创建：${task.task_id}`, 'ok'); pollEffect(task.task_id); }
      return;
    }
    if (engine === 'motion_control') {
      mvNote('提交 Motion Control（模板 motion_control_2）…');
      const task = await api('/api/effect/dance', { kind: 'dance', image_uri: image });
      if (task.state === 'dry_run') mvNote(`演练模式：template=${task.payload.template}，未产生费用`);
      else { mvNote(`Motion Control 任务 ${task.task_id} 生成中…`); pollEffect(task.task_id); }
      return;
    }
    /* MV Agent 1.0 / 2.0：默认本人形象（bridge.avatarImage），与 S2 Avatar 共用一套入参图；
       资产形象 ID 不参与生成（仅播放/恢复）。可选公开 MV 视频链接自动提取音轨当歌曲。 */
    const mode = element('mvMode').value;
    const videoUrl = element('mvVideoUrl').value.trim();
    let task;
    if (videoUrl) {
      const local = Boolean(uploadedVideo && videoUrl === uploadedVideo.url);
      mvNote(`提交 MV Agent ${engine === 'mv2' ? '2.0' : '1.0'}（${mode}，${local ? '已上传视频' : '服务端从视频链接'}提取音轨）…`);
      task = await api('/api/mv/create', local
        ? { video_name: uploadedVideo.name, mode, image_uri: image, version: engine === 'mv2' ? '2.0' : '1.0', prompt: mvPromptText() }
        : { video_url: videoUrl, mode, image_uri: image, version: engine === 'mv2' ? '2.0' : '1.0', prompt: mvPromptText() });
    } else {
      const music = element('singMusic').value;
      if (!music) { mvNote('请选择曲目，或填入 MV 视频链接'); return; }
      mvNote('解码校验音乐…');
      const response = await fetch(`/api/sing/file?name=${encodeURIComponent(music)}`);
      if (!response.ok) throw new Error(`音乐文件拉取失败 HTTP ${response.status}`);
      const { duration } = await decodeMusicPcm(await response.arrayBuffer());
      mvNote(`提交 MV Agent ${engine === 'mv2' ? '2.0' : '1.0'}（${mode}，${duration.toFixed(0)}s）…`);
      task = await api('/api/mv/create', { music, mode, image_uri: image, duration_s: Math.round(duration), version: engine === 'mv2' ? '2.0' : '1.0', prompt: mvPromptText() });
    }
    mvTask = task;
    feed(`MV · 任务已创建：${task.task_id}（Agent ${engine === 'mv2' ? '2.0' : '1.0'} · ${mode}）生成需数分钟`, 'ok');
    pollMv(task.task_id, 0);
  } catch (error) {
    mvNote(`生成失败：${error.message}`);
    feed(`生成失败：${error.message}`, 'err');
  } finally { element('mvCreate').disabled = false; }
}

async function pollMv(taskId, attempt = 0) {
  if (attempt > 120) { mvNote('轮询超时，可稍后手动刷新'); return; }
  try {
    const task = await api(`/api/mv/task/${taskId}`);
    mvTask = task;
    if (task.state === 'success' && task.url) {
      mvNote('MV 已就绪');
      element('mvPlay').disabled = false;
      feed('MV · 生成完成，可离线播放（type=16 切换形象）', 'ok');
      return;
    }
    if (task.state === 'failed') { mvNote(`MV 生成失败：${taskId}`); feed('MV · 生成失败', 'err'); return; }
    mvNote(`生成中… 已等待 ${attempt * 10}s`);
    setTimeout(() => pollMv(taskId, attempt + 1), 10000);
  } catch (error) { mvNote(`轮询失败：${error.message}`); }
}

/* ---------- 自然度参数（S2 组件版）：表单 ⇄ /api/s2/params ---------- */

function fillS2Form(value) {
  if (!value) return;
  const n = value.naturalness || {};
  element('s2Resolution').value = value.resolution || '720p';
  element('s2Library').value = value.action?.library_id ?? '0';
  element('s2ActionEnabled').checked = Boolean(value.action?.enabled);
  element('s2Prompt').value = value.action_prompt || '';
  element('s2Idle').value = n.idle?.interval_s ?? 12;
  element('s2Rest').value = n.idle?.rest_s ?? 4;
  element('s2DanceSeg').value = n.dance?.segment_seconds ?? 2;
  element('s2Hold').value = n.transition?.hold_ms ?? 400;
  element('s2Tail').value = n.singing?.tail_pad_ms ?? 600;
  element('s2Ducking').value = n.singing?.ducking ?? 0.35;
  element('s2Baseline').checked = n.transition?.baseline_reset !== false;
  element('s2OnReady').checked = n.transition?.switch_on_ready !== false;
  element('s2SuppressIdle').checked = n.singing?.suppress_idle !== false;
  element('s2Bridge').checked = n.dance?.bridge_action !== false;
  element('s2Videos').value = (n.transition?.videos || []).join('\n');
}

function s2FromForm() {
  const base = s2 || {};
  return {
    model: base.model || 'vidu-s2',
    resolution: element('s2Resolution').value,
    action: { enabled: element('s2ActionEnabled').checked, library_id: element('s2Library').value.trim() || '0' },
    action_prompt: element('s2Prompt').value.trim(),
    naturalness: {
      transition: {
        baseline_reset: element('s2Baseline').checked,
        switch_on_ready: element('s2OnReady').checked,
        videos: element('s2Videos').value.split(/\s+/).map(item => item.trim()).filter(Boolean),
        hold_ms: Number(element('s2Hold').value),
        auto_from_recent: base.naturalness?.transition?.auto_from_recent !== false,
      },
      singing: {
        suppress_idle: element('s2SuppressIdle').checked,
        tail_pad_ms: Number(element('s2Tail').value),
        ducking: Number(element('s2Ducking').value),
      },
      dance: {
        segment_seconds: Number(element('s2DanceSeg').value),
        bridge_action: element('s2Bridge').checked,
        bridge_text: base.naturalness?.dance?.bridge_text || '面向镜头微笑',
      },
      idle: { interval_s: Number(element('s2Idle').value), rest_s: Number(element('s2Rest').value) },
    },
  };
}

function renderS2Extras() {
  const row = element('s2Presets');
  row.replaceChildren();
  for (const preset of s2Meta?.presets || []) {
    const button = document.createElement('button');
    button.className = 'chip';
    button.textContent = preset.label;
    button.title = preset.hint;
    button.onclick = () => { fillS2Form(preset.value); toast(`已套用预设：${preset.label}（记得点保存）`); };
    row.appendChild(button);
  }
  const guide = element('s2Guide');
  guide.replaceChildren();
  for (const item of s2Meta?.guidance || []) {
    const div = document.createElement('div');
    div.className = 'intent-row';
    div.innerHTML = `<div><b>${item.label}</b><small>${item.note}</small></div>`;
    guide.appendChild(div);
  }
  if (s2Meta?.note) element('s2Note').textContent = s2Meta.note;
}

async function loadS2() {
  try {
    const data = await api('/api/s2/params');
    s2 = data.s2; s2Meta = data.meta;
    fillS2Form(s2);
    renderS2Extras();
  } catch (error) { feed(`自然度参数加载失败：${error.message}`, 'err'); }
}

async function saveS2() {
  try {
    const data = await api('/api/s2/params', { s2: s2FromForm() });
    s2 = data.s2; s2Meta = data.meta;
    fillS2Form(s2); renderS2Extras();
    if (s2.naturalness?.idle) element('cfgIdle').value = s2.naturalness.idle.interval_s;
    toast(data.note || '参数已保存');
    feed(`自然度参数已保存 · ${s2.resolution} · 小动作 ${s2.naturalness.idle.interval_s}s · 转场驻留 ${s2.naturalness.transition.hold_ms}ms`, 'ok');
  } catch (error) { toast(error.message, true); }
}

async function previewS2() {
  try {
    const data = await api('/api/s2/preview', { s2: s2FromForm() });
    const out = element('s2PreviewOut');
    out.hidden = false;
    out.textContent = JSON.stringify(data.payload, null, 2);
  } catch (error) { toast(error.message, true); }
}

/* 转场：type=15 复位 → 驻留 → type=16 播放转场视频并换形象（消除黑帧与残留姿势） */
async function switchAvatarWithTransition(videos, avatarId) {
  const config = s2?.naturalness?.transition || {};
  if (config.baseline_reset !== false) {
    bridge.stream()?.baselineReset();
    feed('转场 · 已发 baseline_reset（type=15），画面复位到闭口静息态');
  }
  await sleep(config.hold_ms ?? 400);
  if (!bridge.stream()?.switchAvatar) return false;
  const transitionVideo = (videos || []).find(Boolean);
  if (transitionVideo) playFullTransition(transitionVideo);
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('s2-command-result', onResult);
      resolve(ok);
    };
    const onResult = event => {
      const result = event.detail || {};
      if (result.source === 'switch_avatar' && result.status === 'finished') finish(result.success !== false);
    };
    window.addEventListener('s2-command-result', onResult);
    const ok = bridge.stream().switchAvatar(videos, avatarId, { switchOnReady: config.switch_on_ready !== false });
    if (!ok) finish(false);
    setTimeout(() => finish(true), 15000);
  });
}

function configuredAvatarId() {
  return element('s2AvatarId')?.value.trim() || localStorage.getItem('s2_transition_avatar') || savedAvatarId();
}

async function beforePerformance(kind) {
  const videos = (s2?.naturalness?.transition?.videos || []).filter(Boolean);
  const avatarId = configuredAvatarId();
  if (!videos.length || !avatarId) return false;
  feed(`${kind} · 先播放转场，避免起手黑帧`);
  return switchAvatarWithTransition(videos, avatarId);
}

function transitionVideosFromRecent() {
  const configured = (s2?.naturalness?.transition?.videos || []).filter(Boolean);
  if (configured.length) return configured;
  if (s2?.naturalness?.transition?.auto_from_recent !== false && mvTask?.url) return [mvTask.url];
  return [];
}

function savedAvatarId() {
  return element('mvAvatarId').value.trim() || localStorage.getItem('s2_avatar_id') || '';
}

async function playMvOffline() {
  if (!mvTask?.url) { toast('还没有已生成的 MV', true); return; }
  if (!bridge.liveActive()) { toast('请先开播，再播放离线 MV', true); return; }
  const avatarId = savedAvatarId();
  if (!avatarId) { toast('请先填写资产形象 ID（avatar_id），否则播完无法切回原形象', true); return; }
  localStorage.setItem('s2_avatar_id', avatarId);
  const ok = await switchAvatarWithTransition([mvTask.url], avatarId);
  if (ok) {
    element('mvPlay').disabled = true;
    feed(`离线MV · type=16 已发出，MV 播完新形象才生效；成功无回执（失败看日志 103）`, 'ok');
  } else feed('离线MV · 信令发送失败（WS 未就绪或 URL 非法）', 'err');
}

async function restoreAvatar() {
  const avatarId = savedAvatarId();
  if (!avatarId) { toast('请先填写资产形象 ID（avatar_id）', true); return; }
  if (!bridge.liveActive()) { toast('请先开播', true); return; }
  const videos = transitionVideosFromRecent();
  if (!videos.length) { toast('切回原形象需要一个转场视频：在「自然度参数」里填视频，或先生成一个 MV', true); return; }
  const ok = await switchAvatarWithTransition(videos, avatarId);
  if (ok) feed('恢复形象 · type=16 已发出：转场视频播完后切回原形象', 'ok');
  else feed('恢复形象 · 信令发送失败', 'err');
}

window.__switchAvatarFailed = error => {
  element('mvPlay').disabled = false;
  feed(`type=103 · switch_avatar 失败：${error.error_code || '?'}（可重试，注意勿重复播放）`, 'err');
};

/* ---------- 事件注入 ---------- */

async function injectEvent(payload) {
  try {
    if (showroomSequenceToken && !showroomSequenceToken.cancelled) {
      showroomSequenceToken.cancelled = true;
      bridge.interrupt?.();
      feed('样板间脚本 · 收到弹幕，立即切换为互动');
    }
    const result = await api('/api/interaction/event', payload);
    if (result.dropped) { feed(`调度器 · 已过滤（${result.classification?.name || result.classification?.matched || '低价值'}）：${payload.text || payload.gift || payload.type}`); return; }
    if (result.queued) { feed('调度器 · 主播正在播报，已进入提问队列'); return; }
    if (result.plan) { feed(`调度器 · ${result.plan.trigger}（P${result.plan.priority}）→ 双轨执行`); await executePlan(result.plan); }
  } catch (error) { feed(`事件注入失败：${error.message}`, 'err'); toast(error.message, true); }
}

element('consoleButton').onclick = () => openDrawer(element('consoleDrawer').hidden);
element('closeConsole').onclick = () => openDrawer(false);
element('saveTriggers').onclick = saveTriggers;
element('s2Save').onclick = saveS2;
element('s2Preview').onclick = previewS2;
element('saveOpening').onclick = saveOpening;
element('saveTiers').onclick = saveTiers;
element('sendDanmaku').onclick = () => {
  const text = element('danmakuInput').value.trim();
  if (!text) return;
  element('danmakuInput').value = '';
  injectEvent({ type: 'comment', text });
};
element('danmakuInput').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) element('sendDanmaku').click(); };
for (const chip of document.querySelectorAll('#consoleDrawer .chip[data-comment]')) chip.onclick = () => injectEvent({ type: 'comment', text: chip.dataset.comment });
for (const chip of document.querySelectorAll('#consoleDrawer .chip[data-gift]')) chip.onclick = () => {
  const gift = chip.textContent.trim().replace(/^[^\w\s]+\s*/, '').replace(/\s*¥?\d+$/, '').trim() || '礼物';
  injectEvent({ type: 'gift', gift, value: Number(chip.dataset.gift) });
  /* 礼物点击 → 后台直接真实生成直播特效（不阻塞事件注入），完成后覆盖播放 */
  triggerGiftFx(gift);
};
for (const chip of document.querySelectorAll('#consoleDrawer .chip[data-pk]')) chip.onclick = () => injectEvent({ type: 'pk_start' });
for (const chip of document.querySelectorAll('#consoleDrawer .chip[data-pkend]')) chip.onclick = () => injectEvent({ type: 'pk_end', win: chip.dataset.pkend === 'win' });

/* 自动弹幕：模拟观众发言，驱动主播按人设话术主动互动（演唱中自动暂停） */
const MOCK_COMMENTS = [
  '主播今天状态也太好了吧', '这身衣服好显气质，哪买的', '唱一个呗，想听歌', '哈哈哈哈笑死我了',
  '主播播多久啦，刚进来', '关注了，以后天天来', '来个才艺表演！', '姐姐声音好好听',
  '这个游戏怎么玩的，带我一个', '扣个1想听你唱歌', '今天播到几点呀', '背景是哪里，好漂亮',
  '刚刷到直播间，背景音乐叫什么', '主播哪个城市的呀',
];
let mockTimer = null;
function toggleMockDanmaku() {
  const button = element('autoDanmaku');
  if (mockTimer) {
    clearInterval(mockTimer);
    mockTimer = null;
    button.textContent = '🤖 自动弹幕 关';
    button.setAttribute('aria-pressed', 'false');
    feed('自动弹幕 · 已关闭');
    return;
  }
  mockTimer = setInterval(() => {
    if (!bridge?.isRunning?.() || singing || window.SALES_SCRIPT_RUNNING) return;
    const text = MOCK_COMMENTS[Math.floor(Math.random() * MOCK_COMMENTS.length)];
    injectEvent({ type: 'comment', text });
  }, 2200 + Math.floor(Math.random() * 3000));
  button.textContent = '🤖 自动弹幕 开';
  button.setAttribute('aria-pressed', 'true');
  feed('自动弹幕 · 已开启（每 2.2–5.2 秒一条模拟发言，演唱中暂停）');
}
element('autoDanmaku').onclick = toggleMockDanmaku;

/* 直播特效礼物 chips：即时叠层动效 + Vidu 具名模板生成，完成后覆盖播放 */
async function triggerFx(key, label) {
  try {
    const icon = label.match(/^\S+/)?.[0] || '';
    const giftName = label.replace(/^\S+\s*/, '').trim() || '礼物';
    // 特效礼物也要触发致谢口播（低档：致谢 + 小动作），再叠加视觉特效。
    injectEvent({ type: 'gift', gift: giftName, value: 6 }).catch(error => feed(`致谢未触发：${error.message}`, 'err'));
    bridge.giftOverlay?.(giftName, undefined, icon);
    const image = await bridge.avatarImage();
    if (!image) { feed('特效 · 未选择主播形象，无法发起特效任务', 'err'); return; }
    const task = await api('/api/effect/dance', { kind: 'effect', fx: key, image_uri: image });
    if (task.state === 'dry_run') feed(`特效 · ${label} 演练：template=${task.payload.template}（${task.host}），未产生费用（dry_run）`);
    else { feed(`特效 · ${label} 任务已创建：${task.task_id}（${task.host}）`); pollEffect(task.task_id); }
  } catch (error) { feed(`特效 · ${label} 失败：${error.message}`, 'err'); toast(error.message, true); }
}
for (const chip of document.querySelectorAll('#fxChips .chip[data-fx]')) chip.onclick = () => triggerFx(chip.dataset.fx, chip.textContent.trim());

/* 礼物 → 特效：后台真实生成（real 绕过 dry_run），即时反馈仍走图标动效 */
let giftFxBusy = false;
async function triggerGiftFx(giftName) {
  if (giftFxBusy) { feed(`礼物特效 · 「${giftName}」生成中，本次仅即时动效`); return; }
  try {
    giftFxBusy = true;
    const image = await bridge.avatarImage();
    if (!image) { feed('礼物特效 · 未选择主播形象，无法发起特效生成', 'err'); return; }
    feed(`礼物特效 · 「${giftName}」后台生成中（Vidu 真实模板，完成后自动覆盖播放）…`);
    const task = await api('/api/gift/fx', { gift: giftName, image_uri: image });
    feed(`礼物特效 · 任务已创建：${task.task_id}（${task.host} · ${task.payload?.template || ''}）`, 'ok');
    pollEffect(task.task_id);
  } catch (error) { feed(`礼物特效 · ${giftName}：${error.message}`, 'err'); }
  finally { giftFxBusy = false; }
}

/* ---------- 已生成视频：本地上传 + 直接播放（双模式之二：不生成，贴链接即播） ---------- */
let uploadedVideo = null; // { name, url } 最近一次上传的本地视频

async function uploadVideoFile(file) {
  if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name)) { toast('仅支持 mp4 / webm / mov / m4v 视频', true); return; }
  if (file.size > 120 * 1024 * 1024) { toast('视频超过 120MB 上限', true); return; }
  element('videoUpload').disabled = true;
  feed(`视频上传 · ${file.name}（${(file.size / 1048576).toFixed(1)}MB）上传中…`);
  try {
    const response = await fetch('/api/video/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `上传失败 HTTP ${response.status}`);
    uploadedVideo = { name: result.name, url: result.url };
    element('overlayVideoUrl').value = result.url;
    element('motionRefVideo').value = result.url;
    element('mvVideoUrl').value = result.url;
    element('videoUploadPlay').hidden = false;
    feed(`视频上传 · 完成（${result.duration_s ? `${result.duration_s.toFixed(0)}s` : '时长未知'}）：已填入播放 / 跳舞参考 / MV 音轨`, 'ok');
  } catch (error) { feed(`视频上传 · ${error.message}`, 'err'); toast(error.message, true); }
  finally { element('videoUpload').disabled = false; element('videoFile').value = ''; }
}

function playReadyVideo() {
  const url = element('overlayVideoUrl').value.trim();
  if (!url) { toast('先粘贴已生成的视频链接', true); return; }
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/media/videos/')) { toast('需要 http(s) 或已上传视频链接', true); return; }
  playOverlay(url, true);
  feed(`已生成视频 · 直接覆盖播放：${url.slice(0, 80)}`);
}

/* ---------- 直播小游戏（数字炸弹 / 拆弹剪线） ---------- */
async function loadGames() {
  try {
    const data = await api('/api/games/status');
    const select = element('gameSelect');
    const first = !select.options.length;
    if (first) {
      select.replaceChildren();
      for (const game of data.supported) element('gameSelect').appendChild(new Option(game.name, game.id));
    }
    element('gameHint').textContent = data.active
      ? `进行中：${data.active.name} · 观众弹幕直接参与，送中档以上礼物可买情报`
      : '开局后观众弹幕直接参与；游戏中送中档以上礼物可向主播买情报。';
  } catch { /* 静默 */ }
}

async function controlGame(action) {
  const game = element('gameSelect').value;
  try {
    element('gameStart').disabled = true;
    element('gameStop').disabled = true;
    const result = await api('/api/interaction/event', { type: 'game_control', game, action });
    if (result.plan) { feed(`小游戏 · ${action === 'start' ? '开局' : '收局'}口播已发出`); await executePlan(result.plan); }
    else feed('小游戏 · 已收局');
    await loadGames();
  } catch (error) { feed(`小游戏 · ${error.message}`, 'err'); toast(error.message, true); }
  finally { element('gameStart').disabled = false; element('gameStop').disabled = false; }
}

/* ---------- 图生视频（Q4 Preview）：当前主播形象作首帧入参图 ---------- */
const I2V_DEFAULT_PROMPT = '以参考图中的女主播形象为主角，保持容貌发型一致，面向镜头自然说话并配合手势，影棚灯光，画质细腻';
async function createI2v() {
  try {
    element('i2vCreate').disabled = true;
    const image = await bridge.avatarImage();
    if (!image) throw new Error('未选择主播形象图（图生视频用当前 S2 形象作首帧入参图）');
    const prompt = element('i2vPrompt').value.trim() || I2V_DEFAULT_PROMPT;
    const note = element('i2vNote');
    note.hidden = false;
    note.textContent = '提交图生视频（viduq4-preview，音画同出）…';
    const task = await api('/api/i2v/create', { image_uri: image, prompt, duration: Number(element('i2vDuration').value), resolution: element('i2vResolution').value, real: true });
    if (task.state === 'dry_run') { note.textContent = '演练模式：未调用真实接口、未产生费用'; feed('图生视频 · 演练完成（dry_run）'); }
    else {
      note.textContent = `任务 ${task.task_id} 生成中（约1-3分钟），完成后自动覆盖播放`;
      feed(`图生视频 · 任务已创建：${task.task_id}`, 'ok');
      pollEffect(task.task_id, 0, true);
      note.hidden = true;
    }
  } catch (error) {
    const note = element('i2vNote');
    note.hidden = false;
    note.textContent = `生成失败：${error.message}`;
    feed(`图生视频 · ${error.message}`, 'err');
  } finally { element('i2vCreate').disabled = false; }
}

/* 音色 / 唱歌 / MV 绑定 */
element('voiceFemaleSelect').onchange = () => applyVoice('voiceFemaleSelect');
element('voiceMaleSelect').onchange = () => applyVoice('voiceMaleSelect');
element('auditionVoice').onclick = auditionVoice;
element('detectVoice').onclick = detectVoiceFromAvatar;
element('reloadMusic').onclick = loadMusic;
element('singMusic').addEventListener('focus', () => { if (element('singMusic').options.length <= 1) loadMusic(); }, { once: true });
element('singStart').onclick = startSinging;
element('singStop').onclick = () => stopSinging('手动停止');
element('mvCreate').onclick = createMv;
element('danceEngine').onchange = syncEngineUi;
syncEngineUi();
element('mvPlay').onclick = playMvOffline;
element('mvRestore').onclick = restoreAvatar;
element('videoUpload').onclick = () => element('videoFile').click();
element('videoFile').onchange = () => { if (element('videoFile').files?.[0]) uploadVideoFile(element('videoFile').files[0]); };
element('videoUploadPlay').onclick = () => { if (uploadedVideo) playOverlay(uploadedVideo.url, true); };
element('overlayPlay').onclick = playReadyVideo;
element('gameStart').onclick = () => controlGame('start');
element('gameStop').onclick = () => controlGame('stop');
element('i2vCreate').onclick = createI2v;
if (localStorage.getItem('s2_avatar_id')) element('mvAvatarId').placeholder = `上次使用：${localStorage.getItem('s2_avatar_id')}`;

/* 本地 MP3 → 24k 单声道 PCM → S2 口型；不经过 TTS，可并行 type 9 动作 */
async function playLocalAudio() {
  if (!bridge?.isRunning?.()) { toast('请先开始直播，再播放本地音频', true); return; }
  interruptCurrentPlayback();
  const url = element('localAudioUrl').value.trim() || '/voices/local-tts.mp3';
  const withActions = element('localAudioActions').checked;
  try {
    feed(`本地音频 · 正在读取 ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    await ctx.close();
    const rate = 24000;
    const frames = Math.max(1, Math.ceil(decoded.duration * rate));
    const offline = new OfflineAudioContext(1, frames, rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const floats = rendered.getChannelData(0);
    const pcm = new Uint8Array(floats.length * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    feed(`本地音频 · ${decoded.duration.toFixed(1)}s → 24k PCM，开始对口型`);
    suyuScriptPlaying = true;
    let done = false;
    const playing = bridge.sendPcmRaw(pcm).finally(() => { done = true; });
    if (withActions) {
      await sleep(1200);
      while (!done && bridge.isRunning()) {
        const name = pickFreshAction();
        if (bridge.sendAction(name)) feed(`画面轨 · 本地音频同步动作：${name}`);
        await sleep(3500);
      }
    }
    await playing;
    feed('本地音频 · 播放完成');
  } catch (error) {
    feed(`本地音频失败：${error.message}`, 'err');
    toast(`本地音频失败：${error.message}`, true);
  } finally {
    suyuScriptPlaying = false;
  }
}
element('playLocalAudio').onclick = playLocalAudio;
window.__playLocalAudio = playLocalAudio;

async function startLocalAudioSinging() {
  if (!bridge?.isRunning?.() || !bridge?.isReady?.()) { toast('请先开始直播并等 S2 首帧，再播放本地音频', true); return; }
  interruptCurrentPlayback();
  const rawUrl = element('singAudioUrl').value.trim() || '/voices/local-tts.mp3';
  const lyrics = element('singLyrics').value.trim();
  try {
    feed(`本地开唱 · 读取 ${rawUrl}`);
    const fetchUrl = /^https?:\/\//i.test(rawUrl) ? `/api/audio/fetch?url=${encodeURIComponent(rawUrl)}` : rawUrl;
    const response = await fetch(fetchUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    await ctx.close();
    const rate = 24000;
    const frames = Math.max(1, Math.ceil(decoded.duration * rate));
    const offline = new OfflineAudioContext(1, frames, rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const floats = rendered.getChannelData(0);
    const pcm = new Uint8Array(floats.length * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    singing = true;
    suyuScriptPlaying = true;
    if (lyrics && bridge.sendOutputText) bridge.sendOutputText(lyrics.slice(0, 500));
    feed(`本地开唱 · ${decoded.duration.toFixed(1)}s，24k PCM 对口型`);
    await bridge.sendPcmRaw(pcm);
    bridge.baselineReset?.();
    feed('本地开唱 · 完成，已复位');
  } catch (error) {
    feed(`本地开唱失败：${error.message}`, 'err');
    toast(`本地开唱失败：${error.message}`, true);
  } finally {
    singing = false;
    suyuScriptPlaying = false;
  }
}
element('singLocalStart').onclick = startLocalAudioSinging;

/* 兜底聊天：交互引擎/TTS 异常时也不能只剩动作，保证直播有连续人声 */
async function fallbackChatter() {
  if (fallbackBusy || suyuScriptPlaying || !bridge?.isRunning?.() || singing || executing) return;
  fallbackBusy = true;
  try {
    const line = pickFallbackLine();
    const data = await api('/api/voice/preview', { text: line });
    if (data.audio && bridge.isReady()) {
      lastSpokenAt = Date.now();
      await bridge.speakOut(data.text || line, data.audio, data.text || line);
      lastSpokenAt = Date.now();
      feed(`兜底口播 · ${line.slice(0, 24)}…`);
    }
  } catch (error) {
    feed(`兜底口播失败：${error.message}`, 'err');
  } finally { fallbackBusy = false; }
}

/* 时间+状态触发轮询（冷启动/沉默/才艺锚点/PK拉票/静默小动作）；演唱中暂停主动互动 */
setInterval(async () => {
  if (!bridge?.isRunning?.() || singing || suyuScriptPlaying || window.SALES_SCRIPT_RUNNING) return;
  try {
    const result = await api('/api/interaction/tick', {});
    if (result.plan) { feed(`唤醒触发 · ${result.plan.trigger}`); await executePlan(result.plan); }
    else if (result.idle?.actions?.length) {
      // 静默小动作：纯画面轨待机动作，不出声不打断
      for (const name of result.idle.actions) {
        if (bridge.sendAction(name)) feed(`画面轨 · 静默小动作：${name}`);
      }
    } else if (result.idle?.gaze) {
      feed('画面轨 · 自然停顿：无合适动作，保持镜头/静息');
    } else if (!executing && !suyuScriptPlaying && Date.now() - lastSpokenAt > 2500) {
      await fallbackChatter();
    }
  } catch { /* 下一轮重试 */ }
  refreshFeed();
}, 300);

/* 酥鱼脚本：预演版（本地播放，不推流）与设定版（1.1× 真实开播） */
const SUYU_SCRIPT = [
  { text: '是什么意思呢，你就读就行了……准备好了吗？好', actions: [] },
  { text: '这是我认识的妖银吗？', actions: ['张嘴大笑'] },
  { text: '哈哈哈，这台词是跟你昨天那个有点异曲同工之妙啊，异曲同工', actions: ['边笑边歪头'] },
  { text: '哈哈哈，来，我要酝酿一下', actions: ['抬手捂嘴'] },
  { text: '咱们都来个不一样的版本吧，怎么样', actions: [] },
  { text: '你们酝酿一下，我先给你们来一遍，我先给你们打个样，你们酝酿一下', actions: [] },
  { text: '我给你换一个啊', actions: ['切换背景音乐'] },
  { text: '大家好，我是酥鱼，有一段话憋在我心里很久了，实在忍不住了，今天给大家说段心里话呀', actions: ['抬手捂嘴', '低头念稿'] },
  { text: '我真的想男人想得要发疯了。我躺在床上会想男人，我洗澡的时候会想男人，我出门的时候会想男人', actions: [] },
  { text: '我盯着路边的男人看，我盯着地铁里的男人看，我盯着好朋友的男人看', actions: [] },
  { text: '我孤独呀，我一个人的时候孤独呀', actions: [] },
  { text: '我也想尝尝爱情的苦啊，这世界上这么多男人，为什么没有一个属于我的呢', actions: [] },
  { text: '老板们有没有不要的夜男人，送我两个呀，哈哈哈哈', actions: ['仰头闭眼大笑', '低头收不住笑'] },
];
const SUYU_HOT_SCRIPT = [  { text: '欢迎大家，欢迎各位，最厉害了最厉害了', actions: ['右手脸侧比OK', '歪头卖萌'] },
  { text: '欢迎我自己，欢迎我自己', actions: ['凑近镜头贴脸'] },
  { text: '尖叫声一人屏一个小数好吗，欢迎欢迎欢迎，家人们', actions: ['手放耳后听', '歪头卖萌'] },
  { text: '左上角的福袋领回家了', actions: ['凑近镜头贴脸'] },
  { text: '谁是爱情主播？你们这个爱情主播，我这个单身的主播', actions: ['右手脸侧比OK'] },
  { text: '你们这个叫什么尖叫声呢，我才是尖叫声，你们没夹起来', actions: ['手放耳后听'] },
  { text: '又是我这个缠人的、迷人的小可爱', actions: ['歪头卖萌', '凑近镜头贴脸'] },
  { text: '在这个做数据的时代，能不能做到、能不能做到', actions: ['高举手臂挥舞'] },
  { text: '大哥大姐请继续点赞吧', actions: ['双手比心', '高举手臂挥舞'] },
  { text: '我想和你们超薄0距离', actions: ['凑近镜头贴脸'] },
  { text: '能不能给我来个数据', actions: ['高举手臂挥舞'] },
  { text: '家人们，为什么直播间没大哥大姐', actions: ['摊手轻耸肩'] },
  { text: '欢迎浩仔、欢迎仔仔', actions: ['抬手挥手打招呼'] },
  { text: '你们这种不刷礼物的……', actions: ['假装生气', '歪头卖萌'] },
  { text: '一个性感的小舞蹈送给大家', actions: ['扭胯摆臂', '双手比心', '手指镜头', '甩手', '原地转动'] },
  { text: '记得我爱你就好、我爱你就好', actions: ['双手比心', '手指镜头'] },
  { text: '谢谢大哥，谢谢大哥，谢谢谢谢', actions: ['不停点头致谢', '双手比心'] },
  { text: '行，2,000人跳到1,800', actions: ['低头笑', '摊手轻耸肩'] },
];

const XIAOMEI_SCRIPT = [  { text: '得到了些什么的呢宝宝，宝宝', actions: ['头左倾点右脸颊', '双手回落胸前'] },
  { text: '这就是今天的穿搭，宝宝', actions: ['双手向两侧摊开'] },
  { text: '不要再说对不起了，你再说对不起，给你哈出去', actions: ['右手前指后捂嘴'] },
  { text: '你在飞机上吗？你还要飞起来，搭飞机走', actions: ['右手斜上抬做起飞'] },
  { text: '这就是今天的穿搭了，捂住肚子上的肉肉', actions: ['双手腹前轻遮'] },
  { text: '嗯宝宝', actions: ['歪头双手比小爱心'] },
  { text: '这个是正面，谢谢宝宝，这个是侧面宝宝', actions: ['扶裙摆上半身左转'] },
  { text: '谢谢各位小宝的赞赞，谢谢 soin 万岁', actions: ['双手合十', '轻轻挥手', '点头两次'] },
  { text: '结束了宝宝，摆个 pose，结束了宝宝', actions: ['双手落腰侧定格', '头右倾15度'] },
  { text: '学到了什么了呢，学到了什么了呢', actions: ['双手摊开掌心向上', '右手食指轻点太阳穴'] },
  { text: '宝宝啊，哪里有游泳圈，没有的事情', actions: ['双手腹前左右摆'] },
  { text: '你别乱讲，是你在乱讲小宝', actions: ['右手食指左右晃'] },
  { text: '哪有敷衍二字，我明明很认真的，展示了今年的穿搭', actions: ['双手扶胸口蝴蝶结', '双手向两侧摊开'] },
  { text: '臭弟弟你怎么不认呢，裙子是有故事的，说来听听', actions: ['下巴微抬眼上挑', '扶裙摆', '歪头双手指尖相触'] },
  { text: '哈什么一个星期', actions: ['右手掌心朝镜头打住'] },
  { text: '我不用你给我，你自己收收好', actions: ['双手胸前轻推'] },
  { text: '宝宝你自己收收好，你别借，哎哟', actions: ['右手胸前小幅摆'] },
  { text: '你别介没必要，小宝没必要', actions: ['双手掌心向外摆', '摇头'] },
  { text: '我是老师嘛，对，叫我小美老师', actions: ['右手轻拍胸口', '下巴微抬'] },
  { text: '我自己说自己老师怎么这么别扭', actions: ['右手轻扶额角'] },
  { text: '是的我就是小美老师', actions: ['双手摊开掌心向上'] },
  { text: '教兄弟们学穿搭的宝宝，嗯', actions: ['双手向外摊开', '点头一次'] },
  { text: '还不一定多胖', actions: ['双手摊开', '耸肩一次'] },
  { text: '我就是一个小胖子宝宝', actions: ['双手脸颊两侧比圆'] },
  { text: '300斤呢能不胖吗，背得动吗', actions: ['右手比三', '双手掌心向上轻托'] },
  { text: '记得之前是幼师，你怎么知道的', actions: ['眼睛睁大', '右手轻捂嘴'] },
  { text: '你怎么知道我之前是幼师，我之前教小朋友', actions: ['双手胸前合掌', '点头两次'] },
  { text: '现在在直播间教大朋友了，是不是', actions: ['右手食指前点两次', '头右歪'] },
  { text: '谢谢小宝的关注', actions: ['双手合十', '点头一次'] },
  { text: '紫色啊紫色唇釉', actions: ['右手食指抬至下巴下方'] },
  { text: '谢谢关注', actions: ['右手胸前小幅挥手', '头右倾'] },
  { text: '没有只有音乐声啊宝宝', actions: ['右手抬至耳侧侧耳听'] },
  { text: '不要乱讲哦', actions: ['右手食指左右晃', '挑眉睁眼'] },
  { text: '我们可是非常正能量的，绿色聊天直播间', actions: ['双手扶腰侧', '下巴微抬'] },
  { text: '展示穿搭的直播间', actions: ['双手向两侧摊开'] },
  { text: '你不要给我搞坏了啊，你不要搞坏了', actions: ['右手食指前点两次'] },
  { text: '搞坏了我就要揍你了宝宝', actions: ['右手握小拳胸前轻挥', '嘟嘴'] },
  { text: '什么歹徒兴奋拳打拳吗', actions: ['双手握拳胸前相碰', '头右歪'] },
  { text: '哪里坏了', actions: ['双手摊开', '眼球左右扫', '耸肩'] },
  { text: '哼', actions: ['下巴抬起', '头侧转', '双手浅交叉'] },
  { text: '唯一宝宝干嘛，不告诉你', actions: ['右手食指竖唇前', '头歪'] },
  { text: '谢谢我韵韵宝宝的小心心，谢谢宝宝', actions: ['双手比小爱心', '点头一次'] },
];

const XIAOMEI_CLIP_SCRIPT = [
  { text: '小宝摸摸头', actions: ['摸摸头'] },
  { text: '小宝今天有没有乖呢', actions: ['歪头微笑'] },
  { text: '臭姐姐什么鬼', actions: ['挑眉'] },
  { text: '你要叫我小美姐姐', actions: ['右手轻拍胸口'] },
  { text: '你不要叫我臭姐姐', actions: ['右手食指左右晃'] },
  { text: '你才是臭弟弟呢哼', actions: ['双手叉腰'] },
  { text: '你才是臭弟弟呢', actions: ['右手食指前点'] },
  { text: '谢谢关注', actions: ['双手合十'] },
  { text: '好机会什么意思', actions: ['歪头'] },
  { text: '什么机会宝宝', actions: ['摊手'] },
  { text: '谢谢关注宝宝', actions: ['点头一次'] },
  { text: '打人很痛的', actions: ['握拳轻挥'] },
  { text: '等于歹徒兴奋剂', actions: ['摊手'] },
  { text: '哪有啊我是真的揍宝宝', actions: ['握拳'] },
  { text: '你要是惹到我', actions: ['指向镜头'] },
  { text: '我是真的揍人的', actions: ['双手叉腰'] },
  { text: '我很凶的', actions: ['瞪眼'] },
  { text: '谢谢小宝的关注', actions: ['双手合十'] },
  { text: '谢谢我尤浩宝宝的小心心', actions: ['双手比心'] },
  { text: '谢谢小宝', actions: ['点头一次'] },
  { text: '哼啊', actions: ['歪头哼'] },
  { text: '谢谢我庭树宝宝的高级灯牌', actions: ['双手合十'] },
  { text: '谢谢宝宝', actions: ['点头一次'] },
  { text: '嗯', actions: ['微笑'] },
  { text: '对展示穿搭来的这样吧的形式', actions: ['摊手'] },
];
function previewSubtitle(text) {
  const sub = element('subtitle');
  const line = element('subtitleText');
  if (!sub || !line) return;
  if (text) {
    sub.hidden = false;
    sub.classList.add('static');
    line.textContent = text;
  } else {
    sub.hidden = true;
    line.textContent = '';
  }
}
async function playSuyuScript(mode, preset = 'suyu') {
  const live = mode === 'live';
  if (live && (!bridge?.isRunning?.() || !bridge?.isReady?.())) { toast('直播画面未就绪，请等 S2 首帧后再播放', true); return; }
  const token = ++playbackToken;
  suyuScriptPlaying = true;
  const script = preset === 'hotdance' ? SUYU_HOT_SCRIPT : preset === 'xiaomei_clip' ? XIAOMEI_CLIP_SCRIPT : preset === 'xiaomei' ? XIAOMEI_SCRIPT : SUYU_SCRIPT;
  const label = preset === 'hotdance' ? '抽象搞笑女' : preset === 'xiaomei_clip' ? '小美老师切片' : preset === 'xiaomei' ? '小美老师' : '酥鱼';
  feed(`${label}脚本 · ${live ? '设定版（1.1× 真实开播）' : '预演版（不推流）'} 开始`);
  const spokenLines = new Set();
  let lastAction = '';
  for (const item of script) {
    if (token !== playbackToken) break;
    try {
      const lineText = String(item.text || '').trim();
      if (!lineText || spokenLines.has(lineText)) { feed(`去重跳过：${lineText || '（空行）'}`); continue; }
      spokenLines.add(lineText);
      const data = await api('/api/voice/preview', { text: lineText });
      if (live) {
        if (bridge.isReady()) await bridge.speakOut(data.text || lineText, data.audio, data.text || lineText);
      } else {
        previewSubtitle(lineText);
        await playLocal(data.audio);
      }
      lastSpokenAt = Date.now();
      for (const action of item.actions || []) {
        if (action === lastAction) continue;
        lastAction = action;
        if (live) { if (bridge.sendAction(action)) feed(`画面轨 · ${action}`); }
        else feed(`动作（预演）· ${action}`);
        await sleep(600);
      }
      await sleep(live ? 300 : 500);
    } catch (error) {
      feed(`酥鱼脚本中断：${error.message}`, 'err');
      break;
    }
  }
  if (token === playbackToken) {
    suyuScriptPlaying = false;
    previewSubtitle('');
    feed(`${label}脚本 · 播放完成`);
  }
}
element('suyuDemo').onclick = () => {
  const persona = document.getElementById('showroomPersona')?.value;
  if (!['suyu', 'gaoxiao', 'xiaomei'].includes(persona)) { toast('专属脚本只绑定对应人设，请先选择对应人物', true); return; }
  const preset = persona === 'gaoxiao' ? 'hotdance' : persona === 'xiaomei' ? 'xiaomei_clip' : 'suyu';
  playSuyuScript(element('scriptMode').value, preset);
};
window.__playSuyuScript = playSuyuScript;
element('presetSuyuLive').onclick = () => window.__startSuSuPreset?.('suyu', false);
element('presetHotLive').onclick = () => window.__startSuSuPreset?.('hotdance', false);
element('presetXiaomeiLive').onclick = () => window.__startSuSuPreset?.('xiaomei', false);
element('presetXiaomeiClipLive').onclick = () => window.__startSuSuPreset?.('xiaomei_clip', false);
element('presetXiaomeiPcmLive').onclick = () => window.__startSuSuPreset?.('xiaomei_clip', false, true);

/* 画面就绪 → 立即自动开场（不等 cold_start_delay，无需手动开启语音） */
/* 样板间脚本：开场白 + 3 条主动口播，段间固定 2 秒 */
let showroomSequenceToken = null;
async function playShowroomSequence(sequence) {
  const token = { cancelled: false };
  showroomSequenceToken = token;
  const lines = (sequence?.lines || []).filter(Boolean);
  const fetchLine = async raw => {
    // TTS 不读「人设名」前缀，但句内文本保持完整，不按标点切开。
    const text = String(raw).replace(/^\s*「[^」]{1,30}」\s*/u, '').trim() || String(raw).trim();
    const response = await fetch('/api/voice/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `TTS HTTP ${response.status}`);
    if (!data.audio) throw new Error('TTS 未返回音频');
    return { text: data.text || text, audio: data.audio };
  };
  let next = fetchLine(lines[0]);
  for (let index = 0; index < lines.length; index++) {
    if (token.cancelled) break;
    const current = await next;
    if (index + 1 < lines.length) next = fetchLine(lines[index + 1]);
    if (token.cancelled) break;
    feed(`样板间 · ${sequence.name} 口播 ${index + 1}/${lines.length}：${current.text.slice(0, 22)}…`);
    await bridge.speakOut(current.text, current.audio, current.text);
    if (index < lines.length - 1) await sleep(2000);
  }
  if (showroomSequenceToken === token) showroomSequenceToken = null;
}

/* 自然对话动作线：按真实开播高频动作排权重，循环下发；复杂动作拆成短指令随机组合。 */
const NATURAL_ACTION_LINE = [
  { name: '凑近屏幕看弹幕' },
  { name: '假哭擦泪' },
  { name: '甩头发' },
  { name: '翻白眼' },
  { name: '眨单眼' },
  { name: '捧脸' },
  { name: '歪头笑' },
  { name: '捂嘴偷笑' },
  { name: '整理衣领' },
  { name: '凑近屏幕看弹幕' },
  { name: '托腮' },
  { name: '双手托腮歪头' },
  { name: '拨头发到耳后' },
  { name: '手背贴脸颊' },
  { name: '食指竖在唇边' },
  { name: '单手比耶' },
  { name: '手指点下巴思考' },
  { name: '戳脸颊卖萌' },
  { name: '摸耳垂害羞' },
  { name: '对手指害羞' },
  { name: '握拳加油打气' },
  { name: '拱手作揖感谢' },
  { name: '飞吻' },
  { name: '比枪发射爱心' },
  { name: '手在胸前画心' },
  { name: '打响指' },
  { name: '单手捂胸口' },
  { name: '双手环抱再放开' },
  { name: '抚摸肩颈' },
  { name: '甩头发' },
  { name: '正面抬头微笑' },
  { name: '抬手挥手打招呼' },
  { name: '双手胸前轻拍' },
  { name: '竖起大拇指点赞' },
  { name: '单手比心' },
  { name: '双手摊开掌心朝上' },
  { name: '食指朝上点一下' },
  { name: '五指并拢向下切' },
  { name: '食指竖胸前' },
  { name: '拇指食指张开七字' },
  { name: '一只手比一二三' },
  { name: '双手胸前转一圈' },
  { name: '掌心朝前轻推' },
  { name: '摊手轻耸肩' },
  { name: '困意揉眼' },
  { name: '舔唇抿嘴' },
  { name: '假装生气' },
  { name: '挤眉弄眼做鬼脸' },
  { name: '眼神左看右看回镜头' },
  { name: '双手比耶' },
  { name: '手背擦汗' },
  { name: '五指插发梳一次' },
  { name: '上身左右轻晃' },
];
const ACTION_COMBO = ['甩头发', '凑近屏幕看弹幕', '歪头笑'];
let naturalActionTimer = null;
let naturalActionIndex = 0;
const recentActions = [];
function pickFreshAction() {
  let pool = NATURAL_ACTION_LINE.filter(step => !recentActions.includes(step.name));
  if (!pool.length) { recentActions.length = 0; pool = NATURAL_ACTION_LINE; }
  const step = pool[Math.floor(Math.random() * pool.length)];
  recentActions.push(step.name);
  if (recentActions.length > 8) recentActions.shift();
  return step.name;
}
function startNaturalActionLoop() {
  if (naturalActionTimer) return;
  naturalActionIndex = 0;
  naturalActionTimer = setInterval(() => {
    if (!bridge?.isRunning?.()) { stopNaturalActionLoop(); return; }
    if (naturalActionIndex % 7 === 0) {
      const combo = ACTION_COMBO.filter(action => !recentActions.includes(action));
      const parts = combo.length ? combo : ACTION_COMBO;
      parts.forEach((action, i) => setTimeout(() => { if (bridge?.isRunning?.()) bridge.sendAction(action); }, i * 700));
      parts.forEach(action => { recentActions.push(action); if (recentActions.length > 8) recentActions.shift(); });
      feed(`画面轨 · 自然动作组合：${parts.join(' → ')}`);
      naturalActionIndex++;
      return;
    }
    const name = pickFreshAction();
    naturalActionIndex++;
    if (bridge.sendAction(name)) feed(`画面轨 · 自然动作线：${name}`);
  }, 3500);
  setTimeout(() => bridge.sendAction('正面抬头微笑'), 1200);
}
function stopNaturalActionLoop() {
  clearInterval(naturalActionTimer);
  naturalActionTimer = null;
}

/* 画面就绪 → 优先播放样板间脚本；没有脚本时走通用自动开场 */
window.addEventListener('s2-live-ready', async () => {
  // RTC 首帧事件可能早于 state.running=true；这里以 WS 已就绪为准，
  // 否则样板间脚本会被误判为“未开播”而不播放，表现为长时间无声/卡住。
  if (!bridge?.isReady?.()) return;
  startNaturalActionLoop();
  const sequence = window.__showroomSequence;
  if (sequence) {
    window.__showroomSequence = null;
    try { await playShowroomSequence(sequence); }
    catch (error) { feed(`样板间脚本播放失败：${error.message}`, 'err'); }
    return;
  }
  try {
    const result = await api('/api/interaction/tick', { force_cold_start: true });
    if (result.plan) { feed(`唤醒触发 · ${result.plan.trigger}`); await executePlan(result.plan); }
  } catch (error) { feed(`自动开场失败：${error.message}`, 'err'); }
});

/* ---------- motion_split：1–2s type=9 连跳（排舞计划来自 /api/effect/dance-split） ---------- */
/* 未生成计划时的预览序列；真实连跳以服务端下发的 plan 为准 */
const LATIN_SEQUENCE = [
  { name: '拉丁起势', t: '0–2s', note: '抬头、右手上伸、左手腰侧' },
  { name: '恰恰基本步', t: '2–4s', note: '右-左-右，重心与胯部转换' },
  { name: '纽约步', t: '4–6s', note: '左侧打开，胸部打开，回中' },
  { name: '拉丁定点转', t: '6–8s', note: '左脚为轴右转，后点地' },
  { name: '扇形步', t: '8–10s', note: '前打开，斜上/斜下手线' },
  { name: '拉丁定格', t: '10–12s', note: '半蹲定格，右斜上/左斜下' },
];
let latinPlaying = false;
let latinPlan = null;
let latinAbort = null;

function latinNote(text) {
  const note = element('latinNote');
  note.hidden = !text;
  note.textContent = text || '';
}

/** 当前要展示/执行的步骤：优先服务端计划，其次静态预览 */
function latinSteps() {
  if (latinPlan?.segments?.length) {
    return latinPlan.segments.map(seg => ({
      text: seg.text,
      t: `${seg.at_s}–${Number((seg.at_s + latinPlan.segment_s).toFixed(1))}s`,
      note: `第 ${seg.index + 1}/${latinPlan.segment_count} 段`,
    }));
  }
  return LATIN_SEQUENCE.map(item => ({ text: item.name, t: item.t, note: item.note }));
}

function renderLatinSequence() {
  const host = element('latinSequence');
  if (!host) return;
  host.innerHTML = latinSteps().map((item, index) => `
    <button type="button" data-latin-step="${index}">
      ${item.text}<b>${item.t} · ${item.note}</b>
    </button>
  `).join('');
  host.querySelectorAll('[data-latin-step]').forEach(button => {
    button.onclick = () => sendLatinStep(Number(button.dataset.latinStep));
  });
}

function sendLatinStep(index) {
  const item = latinSteps()[index];
  if (!item) return;
  const ok = bridge.sendAction(item.text);
  feed(ok ? `motion_split · ${item.t} 已发送：${item.text}` : `motion_split · 动作发送失败：${item.text}`, ok ? 'ok' : 'err');
  const host = element('latinSequence');
  host?.querySelectorAll('[data-latin-step]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.latinStep) === index);
  });
}

/** 排舞：只算计划，不生成视频（服务端纯函数，无费用） */
async function buildLatinPlan() {
  const style = element('latinSeqStyle')?.value || 'latin';
  const total = Number(element('latinTotal')?.value) || 12;
  const seg = Number(element('latinSegSec')?.value) || s2?.naturalness?.dance?.segment_seconds || 2;
  latinPlan = await api('/api/effect/dance-split', {
    style,
    total_s: total,
    segment_s: seg,
    bridge: element('latinBridge') ? element('latinBridge').checked : true,
    bridge_text: s2?.naturalness?.dance?.bridge_text,
  });
  renderLatinSequence();
  return latinPlan;
}

async function playLatinAll() {
  if (latinPlaying) { toast('已有一组连跳进行中，先停止', true); return; }
  if (!bridge.isReady()) { latinNote('直播未连接，type=9 指令无处下发'); return; }
  await beforePerformance('跳舞').catch(() => false);
  latinPlaying = true;
  const abort = new AbortController();
  latinAbort = abort;
  element('latinPlayAll').disabled = true;
  element('latinStop').disabled = false;
  try {
    latinNote('生成排舞计划…');
    const plan = await buildLatinPlan();
    latinNote(`${plan.style === 'free' ? '自由舞' : '拉丁舞'}：${plan.segment_count} 段 × ${plan.segment_s}s（逐段 type=9${plan.bridge ? '，段间收势' : ''}）`);
    feed(`motion_split · 计划就绪：${plan.segment_count} 段 × ${plan.segment_s}s（不生成视频，无渲染费用）`, 'ok');
    for (const seg of plan.segments) {
      if (!latinPlaying || abort.signal.aborted) break;
      sendLatinStep(seg.index);
      await sleep(plan.segment_s * 1000);
      if (plan.bridge && seg.index < plan.segment_count - 1 && latinPlaying && !abort.signal.aborted) {
        bridge.sendAction(plan.bridge_text);
      }
    }
    if (latinPlaying && !abort.signal.aborted) {
      bridge.sendAction(plan.bridge_text);
      await sleep(400);
      if (plan.reset_after) bridge.stream()?.baselineReset();
      feed('motion_split · 连跳完成，已发 baseline_reset 复位', 'ok');
      latinNote('本组连跳完成（已复位到闭口静息态）');
    }
  } catch (error) {
    latinNote(`连跳失败：${error.message}`);
    feed(`motion_split 失败：${error.message}`, 'err');
  } finally {
    latinPlaying = false;
    latinAbort = null;
    element('latinPlayAll').disabled = false;
    element('latinStop').disabled = true;
    element('latinSequence')?.querySelectorAll('[data-latin-step]').forEach(button => button.classList.remove('active'));
  }
}

async function createLatinMotionSync() {
  try {
    const videoUrl = element('latinRefVideo').value.trim();
    if (!videoUrl) throw new Error('请先填公开可访问的 12s 拉丁舞参考视频 URL');
    if (!/^https?:\/\//i.test(videoUrl) && !videoUrl.startsWith('/media/videos/')) throw new Error('参考视频须为 http(s) 公开链接或已上传视频');
    const image = await bridge.avatarImage();
    if (!image) throw new Error('未选择主播形象图，无法做 Motion Sync');
    latinNote('提交 Motion Sync（image2dance，约 10 积分/秒）…');
    const payload = uploadedVideo && videoUrl === uploadedVideo.url
      ? { image_uri: image, video_name: uploadedVideo.name }
      : { image_uri: image, video_url: videoUrl };
    payload.real = Boolean(element('latinReal')?.checked);
    const task = await api('/api/effect/motion-sync', payload);
    if (task.state === 'dry_run') {
      latinNote('演练模式：未调用真实接口、未产生费用');
      feed('Motion Sync · 演练完成（dry_run）');
    } else {
      latinNote(`Motion Sync 任务 ${task.task_id} 生成中…完成后自动全屏播放`);
      feed(`Motion Sync · 任务已创建：${task.task_id}`, 'ok');
      pollEffect(task.task_id, 0, true);
    }
  } catch (error) {
    latinNote(`生成失败：${error.message}`);
    feed(`Motion Sync · ${error.message}`, 'err');
  }
}

function syncLatinMode() {
  const mode = element('latinMode').value;
  element('latinSequencePanel').hidden = mode !== 'sequence';
  element('latinMotionPanel').hidden = mode !== 'motion_sync';
  latinNote('');
}

if (element('latinMode')) {
  renderLatinSequence();
  element('latinMode').onchange = syncLatinMode;
  element('latinPlayAll').onclick = playLatinAll;
  element('latinStop').onclick = () => {
    latinPlaying = false;
    element('latinStop').disabled = true;
    element('latinPlayAll').disabled = false;
    latinNote('已停止实时动作序列');
  };
  element('latinUseUpload').onclick = () => {
    if (!uploadedVideo) { toast('还没有上传视频', true); return; }
    element('latinRefVideo').value = uploadedVideo.url;
    latinNote(`已填入上传视频：${uploadedVideo.name}`);
  };
  element('latinGenerate').onclick = createLatinMotionSync;
  syncLatinMode();
}

window.addEventListener('showroom-applied', async event => {
  try {
    manifest = await api('/api/interaction');
    renderManifest();
    renderVoiceCard();
    const next = event.detail?.showroom;
    feed(`样板间已应用：${next?.persona_id || ''} · ${next?.script_id || ''} · ${next?.action_id || ''}`, 'ok');
  } catch (error) {
    feed(`样板间应用后刷新失败：${error.message}`, 'err');
  }
});

(async () => {
  loadS2().catch(() => {});
  try { manifest = await api('/api/interaction'); renderManifest(); feed('中控台已就绪（策略引擎 V2）', 'ok'); }
  catch (error) { feed(`中控台初始化失败：${error.message}`, 'err'); }
})();
