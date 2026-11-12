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
let voices = [];      // 音色档案（/api/config.voices）
let singing = null;   // { abort, session } 实时唱歌会话
let mvTask = null;    // 最近一次 MV 任务 { task_id, url, state }

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
  if (open) { renderManifest(); refreshFeed(); renderVoiceCard(); loadMusic(); loadGames(); }
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
    card.innerHTML = `<b>${persona.name}</b><small>形象：${persona.look || '—'}</small><small>女声：${persona.voice_female_name || '—'} · 男声：${persona.voice_male_name || '—'}</small>`;
    card.onclick = async () => {
      try {
        manifest = await api('/api/interaction/config', { persona_id: persona.id });
        renderManifest();
        renderVoiceCard();
        feed(`人设已切换：${persona.name}（女声：${persona.voice_female_name || '—'} / 男声：${persona.voice_male_name || '—'}）`);
        toast(`已切换：${persona.name}`);
        if (manifest.bound_outfit) await bridge.applyOutfit?.(manifest.bound_outfit);
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
    if (singing?.abort === abort) feed('唱歌 · 演唱完成，恢复互动调度', 'ok');
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

function savedAvatarId() {
  return element('mvAvatarId').value.trim() || localStorage.getItem('s2_avatar_id') || '';
}

function playMvOffline() {
  if (!mvTask?.url) { toast('还没有已生成的 MV', true); return; }
  if (!bridge.liveActive()) { toast('请先开播，再播放离线 MV', true); return; }
  const avatarId = savedAvatarId();
  if (!avatarId) { toast('请先填写资产形象 ID（avatar_id），否则播完无法切回原形象', true); return; }
  localStorage.setItem('s2_avatar_id', avatarId);
  const ok = bridge.stream()?.switchAvatar([mvTask.url], avatarId);
  if (ok) {
    element('mvPlay').disabled = true;
    feed(`离线MV · type=16 已发出，MV 播完新形象才生效；成功无回执（失败看日志 103）`, 'ok');
  } else feed('离线MV · 信令发送失败（WS 未就绪或 URL 非法）', 'err');
}

function restoreAvatar() {
  const avatarId = savedAvatarId();
  if (!avatarId) { toast('请先填写资产形象 ID（avatar_id）', true); return; }
  if (!bridge.liveActive()) { toast('请先开播', true); return; }
  const videos = mvTask?.url ? [mvTask.url] : null;
  if (!videos) { toast('切回原形象需要一个转场视频（复用最近 MV 或先生成）；暂无可用视频', true); return; }
  const ok = bridge.stream()?.switchAvatar(videos, avatarId);
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
    const result = await api('/api/interaction/event', payload);
    if (result.dropped) { feed(`调度器 · 已过滤（${result.classification?.name || result.classification?.matched || '低价值'}）：${payload.text || payload.gift || payload.type}`); return; }
    if (result.queued) { feed('调度器 · 主播正在播报，已进入提问队列'); return; }
    if (result.plan) { feed(`调度器 · ${result.plan.trigger}（P${result.plan.priority}）→ 双轨执行`); await executePlan(result.plan); }
  } catch (error) { feed(`事件注入失败：${error.message}`, 'err'); toast(error.message, true); }
}

element('consoleButton').onclick = () => openDrawer(element('consoleDrawer').hidden);
element('closeConsole').onclick = () => openDrawer(false);
element('saveTriggers').onclick = saveTriggers;
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
    if (!bridge?.isRunning?.() || singing) return;
    const text = MOCK_COMMENTS[Math.floor(Math.random() * MOCK_COMMENTS.length)];
    injectEvent({ type: 'comment', text });
  }, 6000 + Math.floor(Math.random() * 4000));
  button.textContent = '🤖 自动弹幕 开';
  button.setAttribute('aria-pressed', 'true');
  feed('自动弹幕 · 已开启（每 9-14 秒一条模拟发言，演唱中暂停）');
}
element('autoDanmaku').onclick = toggleMockDanmaku;

/* 直播特效礼物 chips：即时叠层动效 + Vidu 具名模板生成，完成后覆盖播放 */
async function triggerFx(key, label) {
  try {
    const icon = label.match(/^\S+/)?.[0] || '';
    bridge.giftOverlay?.(label.replace(/^\S+\s*/, ''), undefined, icon);
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

/* 时间+状态触发轮询（冷启动/沉默/才艺锚点/PK拉票/静默小动作）；演唱中暂停主动互动 */
setInterval(async () => {
  if (!bridge?.isRunning?.() || singing) return;
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
    }
  } catch { /* 下一轮重试 */ }
  refreshFeed();
}, 3000);

/* 画面就绪 → 立即自动开场（不等 cold_start_delay，无需手动开启语音） */
window.addEventListener('s2-live-ready', async () => {
  if (!bridge?.isRunning?.()) return;
  try {
    const result = await api('/api/interaction/tick', { force_cold_start: true });
    if (result.plan) { feed(`唤醒触发 · ${result.plan.trigger}`); await executePlan(result.plan); }
  } catch (error) { feed(`自动开场失败：${error.message}`, 'err'); }
});

/* ---------- 拉丁舞双模式：实时动作序列 / Motion Sync 参考视频 ---------- */
const LATIN_SEQUENCE = [
  { name: '拉丁起势', t: '0–2s', note: '抬头、右手上伸、左手腰侧' },
  { name: '恰恰基本步', t: '2–4s', note: '右-左-右，重心与胯部转换' },
  { name: '纽约步', t: '4–6s', note: '左侧打开，胸部打开，回中' },
  { name: '拉丁定点转', t: '6–8s', note: '左脚为轴右转，后点地' },
  { name: '扇形步', t: '8–10s', note: '前打开，斜上/斜下手线' },
  { name: '拉丁定格', t: '10–12s', note: '半蹲定格，右斜上/左斜下' },
];
let latinPlaying = false;

function latinNote(text) {
  const note = element('latinNote');
  note.hidden = !text;
  note.textContent = text || '';
}

function renderLatinSequence() {
  const host = element('latinSequence');
  if (!host) return;
  host.innerHTML = LATIN_SEQUENCE.map((item, index) => `
    <button type="button" data-latin-step="${index}">
      ${item.name}<b>${item.t} · ${item.note}</b>
    </button>
  `).join('');
  host.querySelectorAll('[data-latin-step]').forEach(button => {
    button.onclick = () => sendLatinStep(Number(button.dataset.latinStep));
  });
}

function sendLatinStep(index) {
  const item = LATIN_SEQUENCE[index];
  if (!item) return;
  const ok = bridge.sendAction(item.name);
  feed(ok ? `拉丁舞 · ${item.t} 已发送：${item.name}` : `拉丁舞 · 动作发送失败：${item.name}`, ok ? 'ok' : 'err');
  const host = element('latinSequence');
  host?.querySelectorAll('[data-latin-step]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.latinStep) === index);
  });
}

async function playLatinAll() {
  if (latinPlaying) return;
  latinPlaying = true;
  element('latinPlayAll').disabled = true;
  element('latinStop').disabled = false;
  latinNote('实时动作序列播放中：6 段 × 2s，跳完自动停');
  for (let index = 0; index < LATIN_SEQUENCE.length && latinPlaying; index += 1) {
    sendLatinStep(index);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  latinPlaying = false;
  element('latinPlayAll').disabled = false;
  element('latinStop').disabled = true;
  element('latinSequence')?.querySelectorAll('[data-latin-step]').forEach(button => button.classList.remove('active'));
  latinNote('实时动作序列结束；如需更连贯的整段舞蹈，请用 Motion Sync。');
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

(async () => {
  try { manifest = await api('/api/interaction'); renderManifest(); feed('中控台已就绪（策略引擎 V2）', 'ok'); }
  catch (error) { feed(`中控台初始化失败：${error.message}`, 'err'); }
})();
