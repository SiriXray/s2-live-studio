import { ViduStream } from './vidu-stream.js';
import { RtcViewer } from './rtc.js';
import { decodePcm, sendPcm, pcmWav, STABLE_FRAME_BYTES } from './audio.js';
import { MonetDirector, abortableDelay } from './monet-director.js';

const element = id => document.getElementById(id);
const state = { config: null, outfits: [], personaOptions: [], selected: null, candidate: null, live: null, stream: null, rtc: null, running: false, starting: false, version: 0, turnVersion: 0, turnAbort: null, busy: false, speaking: false, history: [], recognition: null, previewAudio: null, recorder: null };
const PCM_FRAME_BYTES = new URLSearchParams(location.search).get('pcm') === '20' ? 960 : STABLE_FRAME_BYTES;
Object.assign(state, { reference: null, editing: null, editingStream: null, editingBusy: false, editingVersion: 0, pushUserId: '', editingTimer: null, previewAbort: null, previewUrl: null, previewBusy: false });
Object.assign(state, { monet: null, monetManifest: null, mediaProof: null, editingError: null, actionError: null, lastGestureAt: 0, auditionAudio: null, auditionUrl: null });
let toastTimer;

function toast(message, error = false) {
  element('toast').textContent = message;
  element('toast').className = `toast${error ? ' error' : ''}`;
  element('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element('toast').hidden = true; }, error ? 9000 : 4000);
}

function log(message, level = '') {
  const row = document.createElement('div');
  row.className = level === 'err' ? 'log-error' : level === 'ok' ? 'log-ok' : '';
  row.textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${message}`;
  element('logs').appendChild(row);
  while (element('logs').children.length > 120) element('logs').firstElementChild.remove();
  element('logSummary').textContent = message;
  element('logs').scrollTop = element('logs').scrollHeight;
}

function report(error) { if (error.name !== 'AbortError') { toast(error.message, true); log(error.message, 'err'); } }

async function api(resource, body, options = {}) {
  const response = await fetch(resource, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 HTTP ${response.status}`);
  return result;
}

function controls() {
  element('startButton').hidden = state.running;
  element('startButton').disabled = state.starting || Boolean(state.stopPromise);
  element('startButton').textContent = state.starting ? '正在连接…' : '▶ 开始直播';
  element('stopButton').hidden = !state.running && !state.starting;
  element('chatInput').disabled = !state.stream?.ready;
  element('sendButton').disabled = !state.stream?.ready || state.busy;
  element('interruptButton').disabled = !state.stream?.ready;
  element('micButton').disabled = !state.stream?.ready || !(window.SpeechRecognition || window.webkitSpeechRecognition);
  element('recordButton').disabled = !state.running || state.recorderBusy;
  element('recordButton').textContent = state.recorderBusy ? '⏺ 停止录屏' : '⏺ 开始录屏';
  element('recordButton').setAttribute('aria-pressed', String(Boolean(state.recorderBusy)));
  element('settingsButton').disabled = state.running || state.starting;
  element('voicePreview').disabled = state.running || state.starting || state.previewBusy;
  element('editingButton').disabled = !state.running || !state.reference || state.editingBusy || state.config?.rtc.provider !== 'trtc';
  element('editingButton').textContent = state.editingBusy ? '正在连接 / 切换…' : state.editing ? '切换参考图 / 场景' : '开启实时换装';
  element('stopEditing').hidden = !state.editing && !state.editingBusy;
  const monetReady = state.running && state.monet?.active && !state.stopPromise;
  element('experience').disabled = state.running || state.starting;
  for (const id of ['monetDemo', 'monetMatrix', 'monetVisitor', 'monetClosing', 'monetActionRun']) element(id).disabled = !monetReady || state.busy;
  element('monetCancel').disabled = !monetReady || !state.monet.busy;
  element('monetExport').disabled = !state.monet?.entries.length;
  element('monetIdle').disabled = state.running || state.starting;
  element('monetAvatar').disabled = state.running || state.starting;
}

async function loadConfig() {
  state.config = await api('/api/config');
  const config = state.config;
  const names = { llm: 'LLM（recaption）', minimax: 'MiniMax', vidu: 'Vidu', rtc: 'RTC', soul: 'Soul（备选声音）' };
  const missing = Object.keys(config.readiness).filter(key => !config.readiness[key]);
  const notice = element('notice');
  notice.hidden = missing.length === 0;
  notice.textContent = missing.length ? `还需配置：${missing.map(key => names[key]).join('、')}` : '';
  try { const interaction = await api('/api/interaction/config'); state.personaOptions = interaction.personas; state.activePersona = interaction.config?.persona_id || ''; } catch { state.personaOptions = []; state.activePersona = ''; }
  for (const component of ['llm', 'minimax', 'vidu', 'rtc']) element(`${component}Status`).textContent = config.readiness[component] ? '已配置 · 待验证' : '尚未配置';
  element('rtcName').textContent = { trtc: '腾讯 TRTC', artc: '阿里 ARTC', agora: '声网 Agora' }[config.rtc.provider];
  return config;
}

function renderOutfits() {
  const list = element('outfitList');
  list.replaceChildren();
  const avatars = state.outfits.filter(outfit => outfit.kind !== 'reference');
  element('outfitCount').textContent = String(avatars.length);
  if (!avatars.length) {
    const empty = document.createElement('p'); empty.className = 'empty-small'; empty.textContent = '上传第一张形象图，建立你的造型库。'; list.appendChild(empty);
  }
  for (const outfit of avatars) {
    const card = document.createElement('button');
    card.className = `outfit-card${state.selected?.id === outfit.id ? ' selected' : ''}`;
    card.setAttribute('aria-label', `预览造型：${outfit.name}`);
    card.setAttribute('aria-pressed', String(state.selected?.id === outfit.id));
    const image = document.createElement('img'); image.src = outfit.preview; image.alt = outfit.name; image.loading = 'lazy';
    const boundName = outfit.persona_id ? state.personaOptions.find(p => p.id === outfit.persona_id)?.name : '';
    const name = document.createElement('span'); name.textContent = boundName ? `${outfit.name} · ${boundName}` : outfit.name;
    card.append(image, name);
    card.onclick = () => openCandidate(outfit);
    list.appendChild(card);
  }
  const referenceSelect = element('referenceSelect'); referenceSelect.replaceChildren(new Option('请选择参考图', ''));
  for (const reference of state.outfits.filter(outfit => outfit.kind === 'reference')) referenceSelect.appendChild(new Option(reference.name, reference.id));
  referenceSelect.value = state.reference?.id || '';
  const backgroundSelect = element('monetBackground'); const selectedBackground = backgroundSelect.value;
  backgroundSelect.replaceChildren(new Option('请先上传背景参考图', ''));
  for (const reference of state.outfits.filter(outfit => outfit.kind === 'reference')) backgroundSelect.appendChild(new Option(reference.name, reference.id));
  backgroundSelect.value = selectedBackground;
}

async function loadOutfits() { state.outfits = (await api('/api/outfits')).items; renderOutfits(); }

function selectOutfit(outfit) {
  state.selected = outfit;
  element('currentOutfit').textContent = outfit?.name || '尚未选择';
  if (!state.running) {
    element('previewImage').hidden = !outfit;
    if (outfit) element('previewImage').src = outfit.preview;
    element('stageEmpty').hidden = Boolean(outfit);
  }
  renderOutfits();
}

function openCandidate(outfit) {
  state.candidate = outfit;
  element('candidateImage').src = outfit.preview;
  element('outfitTitle').textContent = outfit.name;
  const personaSelect = element('outfitPersona');
  personaSelect.replaceChildren(new Option('不绑定人设', ''));
  for (const persona of state.personaOptions) personaSelect.appendChild(new Option(`${persona.name} · ${persona.look || persona.voice_name || ''}`, persona.id));
  personaSelect.value = outfit.persona_id || '';
  element('candidateNote').textContent = state.running ? '更换基础形象会重连直播；只换服装请用「实时换装」。' : '静态预览，选为出镜形象后开播。';
  element('applyOutfit').textContent = state.running ? '切换造型并重连' : '选为出镜形象';
  element('applyOutfit').disabled = state.starting || (state.running && state.selected?.id === outfit.id);
  element('deleteOutfit').disabled = state.running && state.selected?.id === outfit.id;
  element('outfitDialog').showModal();
}

/* 大图自动压缩：≤4MB 且最长边 ≤2048 原样直传；否则 canvas 等比缩放 + JPEG 重编码，直到 data URI ≤8MB */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
async function compressImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > 50 * 1024 * 1024) throw new Error('图片超过 50MB 上限，请先在本地缩小后上传');
  const bitmap = await createImageBitmap(file);
  const ratio = bitmap.width / bitmap.height;
  if (ratio < 0.25 || ratio > 4) { bitmap.close(); throw new Error('图片宽高比须在1:4至4:1之间'); }
  const small = file.size <= 4 * 1024 * 1024 && Math.max(bitmap.width, bitmap.height) <= 2048;
  if (small) {
    const uri = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    bitmap.close();
    return uri;
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  for (let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height)); scale >= 0.15; scale *= 0.8) {
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.8, 0.7]) {
      const uri = canvas.toDataURL('image/jpeg', quality);
      if (uri.length * 0.75 <= IMAGE_MAX_BYTES) { bitmap.close(); return uri; }
    }
  }
  bitmap.close();
  throw new Error('图片压缩后仍超出 8MB，请换一张更小的图片');
}

async function importImage(file, kind = 'avatar') {
  if (!file) return;
  const bitmap = await createImageBitmap(file);
  const ratio = bitmap.width / bitmap.height;
  bitmap.close();
  if (ratio < 0.25 || ratio > 4) throw new Error('图片宽高比须在1:4至4:1之间');
  const uri = await compressImage(file);
  const result = await api('/api/outfits/import', { name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || '新造型', kind, image_uri: uri });
  await loadOutfits();
  if (kind === 'reference') { selectReference(result); toast('参考图已上传，可应用到直播'); return; }
  if (!state.selected && !state.running) selectOutfit(result);
  else openCandidate(result);
  toast('形象已加入造型库');
}

/* 人设联动：造型绑定了人设且与当前不同时，切换人设（音色 Soul/MiniMax 双侧 + 动作套装一起生效） */
async function switchPersonaIfNeeded(personaId) {
  if (!personaId || personaId === state.activePersona) return;
  try {
    await api('/api/interaction/config', { persona_id: personaId });
    state.activePersona = personaId;
    toast(`人设已联动切换：${state.personaOptions.find(p => p.id === personaId)?.name || personaId}`);
  } catch (error) { report(error); }
}

/* 备选形象：内置 6 张候选主播图，点击导入造型库并弹窗确认选用；persona 为导入后自动绑定的人设（女生默认活泼亲切-生活 → 音色活泼小榆） */
const PRESET_LOOKS = [
  { file: 'look-queen-long.jpg', name: '御姐黑长直', persona: 'lively_rural' },
  { file: 'look-scholar-suit.jpg', name: '知性西装', persona: 'lively_rural' },
  { file: 'look-jeans-fresh.jpg', name: '元气牛仔', persona: 'lively_rural' },
  { file: 'look-maid-blue.jpg', name: '甜心女仆', persona: 'lively_rural' },
  { file: 'look-wet-hair.jpg', name: '湿发故事感', persona: 'lively_rural' },
  { file: 'look-dark-suit-m.jpg', name: '暗夜西装·男', persona: 'funny_playful' },
];
function renderLookStrip() {
  const strip = element('lookStrip');
  strip.replaceChildren();
  for (const look of PRESET_LOOKS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', `选用备选形象：${look.name}`);
    const image = document.createElement('img');
    image.src = `/looks/${look.file}`; image.alt = look.name; image.loading = 'lazy';
    const label = document.createElement('span'); label.textContent = look.name;
    button.append(image, label);
    button.onclick = async () => {
      button.classList.add('busy');
      try {
        const blob = await (await fetch(`/looks/${look.file}`)).blob();
        const uri = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
        const result = await api('/api/outfits/import', { name: look.name, kind: 'avatar', persona_id: look.persona || '', image_uri: uri });
        await loadOutfits();
        if (!state.selected && !state.running) { selectOutfit(result); await switchPersonaIfNeeded(look.persona); }
        else openCandidate(result);
        toast(`备选形象「${look.name}」已加入造型库`);
      } catch (error) { report(error); }
      finally { button.classList.remove('busy'); }
    };
    strip.appendChild(button);
  }
}

function fillRtcFields() {
  const provider = element('rtcProvider').value;
  const config = state.config.rtc[provider];
  const fields = element('rtcFields'); fields.replaceChildren();
  const appKey = provider === 'trtc' ? 'sdk_app_id' : 'app_id';
  const secretKey = { trtc: 'secret_key', artc: 'app_key', agora: 'app_certificate' }[provider];
  for (const [id, labelText, value, type] of [['rtcAppId', provider === 'trtc' ? 'SDK App ID' : 'App ID', config[appKey] || '', provider === 'trtc' ? 'number' : 'text'], ['rtcSecret', `${{ trtc: 'Secret Key', artc: 'App Key', agora: 'App Certificate' }[provider]}${config[`${secretKey}_set`] ? ' · 已配置' : ''}`, '', 'password']]) {
    const label = document.createElement('label'); label.htmlFor = id; label.textContent = labelText;
    const input = document.createElement('input'); input.id = id; input.type = type; input.value = value;
    if (type === 'password') { input.autocomplete = 'new-password'; input.placeholder = '留空保留原值'; }
    fields.append(label, input);
  }
  element('artcShapeField').hidden = provider !== 'artc';
}

function renderVoiceHint() {
  const option = element('voiceProfile').selectedOptions[0];
  element('voiceProfileHint').textContent = option ? `Soul ${option.dataset.soul} · 回落 ${option.dataset.minimax} · ${option.dataset.hint}` : '';
}

async function auditionVoice() {
  const picked = element('voiceProfile').selectedOptions[0];
  if (!picked) return;
  const button = element('voiceAudition');
  button.disabled = true;
  element('voiceProfileHint').textContent = '试听合成中…';
  try {
    const result = await api('/api/voice/preview', { voice_id: picked.value, text: '大家好，我是今天的主播，先跟你打个招呼，一会儿见。' });
    if (!result.audio) throw new Error('未返回音频');
    if (state.auditionAudio) { state.auditionAudio.pause(); URL.revokeObjectURL(state.auditionUrl); }
    state.auditionUrl = URL.createObjectURL(pcmWav(decodePcm(result.audio)));
    state.auditionAudio = new Audio(state.auditionUrl);
    await state.auditionAudio.play();
    element('voiceProfileHint').textContent = `${result.provider === 'soul' ? 'Soul 克隆' : 'MiniMax 回落'} · ${(result.duration_ms / 1000).toFixed(1)}s · ${picked.dataset.soul}`;
  } catch (error) {
    element('voiceProfileHint').textContent = `试听失败：${error.message}`;
  } finally { button.disabled = false; }
}

function fillVoiceProfiles() {
  const voices = state.config.voices || [];
  const select = element('voiceProfile');
  select.replaceChildren();
  // 女声 / 男声两个分组，同一列表内分区展示
  for (const [label, gender] of [['女声音色', 'female'], ['男声音色', 'male']]) {
    const group = document.createElement('optgroup'); group.label = label;
    for (const voice of voices.filter(item => item.gender === gender)) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.name;
      option.dataset.soul = voice.soul;
      option.dataset.minimax = voice.minimax;
      option.dataset.hint = voice.hint;
      group.appendChild(option);
    }
    if (group.children.length) select.appendChild(group);
  }
  const active = voices.find(voice => voice.id === state.config.active_voice) || voices[0];
  if (active) select.value = active.id;
  select.onchange = renderVoiceHint;
  element('voiceAudition').onclick = auditionVoice;
  renderVoiceHint();
}

async function openSettings() {
  await loadConfig();
  const config = state.config;
  element('viduHost').value = config.vidu.host;
  element('llmModel').value = config.llm.model;
  element('minimaxModel').value = config.minimax.model;
  element('voiceSpeed').value = config.minimax.speed;
  fillVoiceProfiles();
  element('persona').value = config.live.persona;
  element('rtcProvider').value = config.rtc.provider;
  element('inheritHint').textContent = config.inherits_rtc ? '已读取本机 QuickStart RTC 配置。' : '填写自己的 RTC 凭据。';
  for (const provider of ['vidu', 'llm', 'minimax', 'soul']) { element(`${provider}Key`).value = ''; element(`${provider}KeySet`).textContent = config[provider].api_key_set ? '· 已配置' : '· 未配置'; }
  element('settingsError').textContent = '';
  fillRtcFields();
  element('settingsDialog').showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  element('saveSettings').disabled = true;
  const provider = element('rtcProvider').value;
  const appKey = provider === 'trtc' ? 'sdk_app_id' : 'app_id';
  const secretKey = { trtc: 'secret_key', artc: 'app_key', agora: 'app_certificate' }[provider];
  const picked = element('voiceProfile').selectedOptions[0];
  const voice = picked ? { soul: picked.dataset.soul, minimax: picked.dataset.minimax } : { soul: state.config.soul.voice_id, minimax: state.config.minimax.voice_id };
  try {
    await api('/api/config', {
      vidu: { api_key: element('viduKey').value.trim(), host: element('viduHost').value },
      llm: { api_key: element('llmKey').value.trim(), model: element('llmModel').value.trim() },
      minimax: { api_key: element('minimaxKey').value.trim(), model: element('minimaxModel').value.trim(), voice_id: voice.minimax, speed: Number(element('voiceSpeed').value) },
      soul: { api_key: element('soulKey').value.trim(), voice_id: voice.soul },
      live: { persona: element('persona').value.trim() },
      rtc: { provider, [provider]: { [appKey]: provider === 'trtc' ? Number(element('rtcAppId').value) : element('rtcAppId').value.trim(), [secretKey]: element('rtcSecret').value.trim() } },
    });
    for (const field of ['viduKey', 'llmKey', 'minimaxKey', 'soulKey', 'rtcSecret']) element(field).value = '';
    await loadConfig();
    element('settingsDialog').close(); toast('连接设置已保存到本机'); log('连接设置已保存');
  } catch (error) { element('settingsError').textContent = error.message; }
  finally { element('saveSettings').disabled = false; }
}

async function loadSdk(provider) {
  const sdk = {
    trtc: ['TRTC', 'https://web.sdk.qcloud.com/trtc/webrtc/v5/dist/trtc.js'],
    artc: ['AliRtcEngine', 'https://g.alicdn.com/apsara-media-box/imp-web-rtc/7.1.9/aliyun-rtc-sdk.js'],
    agora: ['AgoraRTC', 'https://download.agora.io/sdk/release/AgoraRTC_N-4.24.6.js'],
  }[provider];
  if (window[sdk[0]]) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = sdk[1]; script.async = true;
    const timer = setTimeout(() => { script.remove(); reject(new Error('RTC SDK加载超时，请检查网络')); }, 20000);
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('RTC SDK加载失败，请检查网络')); };
    document.head.appendChild(script);
  });
}

async function start() {
  if (state.starting || state.running || state.stopPromise) return;
  if (!state.selected) { toast('请先上传并选择出镜形象', true); return; }
  const version = ++state.version;
  state.mediaProof = null;
  state.monet = null;
  state.starting = true; controls();
  element('roomStatus').textContent = '连接中';
  try {
    const config = await loadConfig();
    if (version !== state.version) return;
    const blocking = Object.keys(config.readiness).filter(key => key !== 'soul' && !config.readiness[key]);
    if (blocking.length) { element('roomStatus').textContent = '未开播'; await openSettings(); return; }
    stopVoicePreview();
    await loadSdk(config.rtc.provider);
    if (version !== state.version) return;
    log('正在创建外接直播，创建请求不自动重试');
    const experience = element('experience').value;
    if (experience === 'monet' && !state.monetManifest) throw new Error('莫奈任务未加载，请重启本机服务后刷新页面');
    if (experience === 'monet') {
      const library = await api('/api/monet/library');
      if (!library.ready) await prepareMonetLibrary();
      if (version !== state.version) return;
    }
    const created = await api('/api/live', { outfit_id: state.selected.id, experience });
    if (version !== state.version) { await api(`/api/live/${created.live.id}/close`, {}); return; }
    state.live = created.live;
    state.pushUserId = created.push_user_id;
    log(`已创建直播 ${created.live.id}，等待渲染与RTC连接`, 'ok');
    state.stream = new ViduStream({ liveId: created.live.id, onLog: log, onSignal: signal => {
      if (version === state.version && signal.type === 103) { state.actionError = 'Vidu返回操作失败，请查看运行日志并核对账号S2权限'; log(state.actionError, 'err'); }
    }, onSwitchAvatarError: error => {
      log(`切换形象/离线MV失败：${error.error_code || '?'} ${error.error_msg || ''}`, 'err');
      window.__switchAvatarFailed?.(error);
    }, onHangup: reason => { if (version === state.version) { toast(`直播连接已结束：${reason}`, true); stop().catch(report); } } });
    await state.stream.connect();
    if (version !== state.version) return;
    state.rtc = new RtcViewer({ videoEl: element('remoteVideo'), targetUserId: created.push_user_id, audioUserId: created.push_user_id, onLog: log, onMediaVerified: proof => {
      const expectedUser = state.editing?.output_user_id || created.push_user_id;
      if (version !== state.version || proof.userId !== expectedUser) return;
      state.mediaProof = proof;
      element('previewImage').hidden = true; element('stageEmpty').hidden = true;
      element('previewBadge').textContent = 'LIVE'; element('stageLabel').textContent = '直播画面';
      element('frameInfo').textContent = `${proof.width} × ${proof.height} · 视频帧已验证`;
      element('roomStatus').textContent = '直播中'; element('roomStatus').classList.add('live'); element('liveDot').classList.add('on');
      element('rtcStatus').textContent = '视频接收中';
      if (state.editing && proof.userId === state.editing.output_user_id) {
        element('previewBadge').textContent = 'LIVE · Editing';
        element('editingStatus').textContent = '已接收Editing视频流，请确认画面中的服装是否符合预期。';
        element('confirmEditing').hidden = false;
      }
      maybeWelcomeMonet();
      // 画面就绪 → 通知中控台立即自动开场（不等冷启动延迟）
      window.dispatchEvent(new CustomEvent('s2-live-ready'));
    } });
    await state.rtc.join(config.rtc.provider, created.viewer, { artcTokenShape: element('artcTokenShape').value });
    if (version !== state.version) return;
    state.running = true; state.history = [];
    if (experience === 'monet') state.monet = createMonetDirector();
    api('/api/interaction/event', { type: 'live_start', live_id: created.live.id }).catch(() => {});
    element('viduStatus').textContent = '渲染连接就绪';
    element('roomStatus').textContent = element('liveDot').classList.contains('on') ? '直播中' : '已连接 · 等待画面';
    element('turnStatus').textContent = '连接就绪，可以开始对话';
    log('对话通道就绪；仅将MiniMax回复语音送入Vidu，不混入麦克风原声', 'ok');
    maybeWelcomeMonet();
  } catch (error) { if (version === state.version) { report(error); await stop(); } }
  finally { if (version === state.version) { state.starting = false; controls(); } }
}

function interrupt(cancelMonet = true) {
  if (cancelMonet) state.monet?.cancel();
  state.turnVersion++;
  state.turnAbort?.abort(); state.turnAbort = null;
  state.stream?.interrupt(); state.busy = false;
  element('subtitle').hidden = true;
  element('turnStatus').textContent = state.running ? '已打断，等待下一句话' : '等待开始直播';
  controls();
}

function stopRecognition() {
  if (state.recognition) { state.recognition.onend = null; state.recognition.abort(); state.recognition = null; }
  element('micButton').textContent = '开启语音输入'; element('micButton').setAttribute('aria-pressed', 'false');
}

function stop() {
  if (state.stopPromise) return state.stopPromise;
  state.stopPromise = stopSession().finally(() => { state.stopPromise = null; controls(); });
  return state.stopPromise;
}

async function stopSession() {
  ++state.version;
  state.monet?.stop();
  interrupt(); stopRecognition();
  await stopEditing(false);
  const live = state.live; const rtc = state.rtc; const stream = state.stream;
  state.live = state.rtc = state.stream = null; state.running = state.starting = false;
  stream?.close();
  if (rtc) await rtc.leave();
  if (live) await api(`/api/live/${live.id}/close`, {}).catch(report);
  element('videoHost').replaceChildren(element('remoteVideo'));
  element('roomStatus').textContent = '未开播'; element('roomStatus').classList.remove('live'); element('liveDot').classList.remove('on');
  element('stageLabel').textContent = '画面预览'; element('previewBadge').textContent = '预览'; element('frameInfo').textContent = '尚未接收视频流';
  element('turnStatus').textContent = '等待开始直播';
  selectOutfit(state.selected); controls();
  api('/api/interaction/event', { type: 'live_end' }).catch(() => {});
  await loadConfig().catch(report);
  log('直播连接与音频任务已释放');
}

function selectReference(reference) {
  state.reference = reference;
  element('referencePreview').hidden = !reference;
  if (reference) element('referencePreview').src = reference.preview;
  element('referenceName').textContent = reference?.name || '上传服装参考图';
  element('referenceSelect').value = reference?.id || '';
  controls();
}

async function stopEditing(restore = true) {
  state.editingVersion++;
  clearTimeout(state.editingTimer);
  const editing = state.editing;
  state.editingStream?.close();
  state.editing = state.editingStream = null;
  state.editingBusy = false;
  if (editing) await api(`/api/live/${editing.live.id}/close`, {}).catch(report);
  if (restore && state.rtc && state.pushUserId) await state.rtc.setVideoUser(state.pushUserId);
  element('confirmEditing').hidden = true;
  element('editingStatus').textContent = 'Editing已关闭，可重新选择参考图。';
  controls();
}

async function applyEditing() {
  if (!state.running || !state.reference || state.editingBusy) return;
  if (state.config.rtc.provider !== 'trtc') throw new Error('当前组合直播使用腾讯TRTC');
  const version = ++state.editingVersion;
  state.editingError = null;
  state.editingBusy = true; controls();
  element('confirmEditing').hidden = true;
  try {
    if (state.editingStream?.ready) {
      const result = await api(`/api/outfits/${state.reference.id}/reference`);
      if (version !== state.editingVersion) return;
      if (!state.editingStream.switchPrompt(result.image_uri, element('editingType').value)) throw new Error('换图信令发送失败');
      element('editingStatus').textContent = '换图指令已发送，请确认画面效果。';
      log('已发送Editing type=13 switch_prompt，尚未确认画面效果');
      element('confirmEditing').hidden = false;
      state.editingTimer = setTimeout(() => { if (version === state.editingVersion) { state.editingBusy = false; controls(); } }, 5000);
      return;
    }
    element('editingStatus').textContent = '正在创建Editing，输入为Avatar在同一房间的原始视频流…';
    const result = await api(`/api/live/${state.live.id}/editing`, { reference_id: state.reference.id, editing_type: element('editingType').value });
    if (version !== state.editingVersion || !state.running) { await api(`/api/live/${result.live.id}/close`, {}); return; }
    state.editing = result;
    state.editingStream = new ViduStream({ liveId: result.live.id, keepAlive: false, maxSignalBytes: 16 * 1024 * 1024, onLog: message => log(`Editing · ${message}`), onSignal: signal => {
      if (state.editing?.live.id !== result.live.id) return;
      if (signal.type === 14) {
        const acknowledgement = signal.payload?.switch_prompt_ack || signal.payload?.switch_prompt || signal.payload?.error || signal.payload || {};
        element('editingStatus').textContent = `换装失败：${acknowledgement.error_code || acknowledgement.code || 'type=14'} ${acknowledgement.error_msg || acknowledgement.message || ''}`;
        element('confirmEditing').hidden = true;
        log(element('editingStatus').textContent, 'err');
        state.editingError = element('editingStatus').textContent;
      }
    }, onHangup: reason => { if (state.editing?.live.id === result.live.id) { log(`Editing已结束：${reason}`, 'err'); stopEditing().catch(report); } } });
    await state.editingStream.connect();
    if (version !== state.editingVersion) return;
    await state.rtc.setVideoUser(result.output_user_id);
    if (version !== state.editingVersion) return;
    state.editingBusy = false; controls();
    element('editingStatus').textContent = 'Editing就绪，等待结果流。';
    log(`Editing ${result.live.id} 订阅Avatar用户 ${result.input_user_id}，输出用户 ${result.output_user_id}`);
  } catch (error) {
    if (version === state.editingVersion) { await stopEditing(); element('editingStatus').textContent = error.message; }
    throw error;
  }
}

function pushDanmaku(content, role = '观众') {
  const track = element('danmakuTrack');
  if (!track) return;
  const item = document.createElement('span');
  item.className = `danmaku-item${role === '主播' ? ' host' : ''}`;
  const label = document.createElement('b');
  label.textContent = role;
  const text = document.createElement('span');
  text.textContent = content;
  item.append(label, text);
  track.appendChild(item);
  while (track.children.length > 24) track.firstElementChild.remove();
}

function addMessage(role, content) {
  element('chatEmpty')?.remove();
  const message = document.createElement('div'); message.className = `message ${role}`;
  const label = document.createElement('span'); label.textContent = role === 'user' ? '你' : '主播 · recaption';
  const text = document.createElement('p'); text.textContent = content;
  message.append(label, text); element('conversation').appendChild(message);
  while (element('conversation').children.length > 60) element('conversation').firstElementChild.remove();
  element('conversation').scrollTop = element('conversation').scrollHeight;
  if (role === 'user') pushDanmaku(content);
}

async function sendTurn(text) {
  if (!state.stream?.ready || !text.trim()) return;
  if (state.monet?.active) {
    addMessage('user', text);
    return state.monet.run({ event: 'turn', text }).catch(report);
  }
  interrupt();
  const version = ++state.turnVersion;
  const controller = new AbortController(); state.turnAbort = controller; state.busy = true; controls();
  addMessage('user', text); element('turnStatus').textContent = 'recaption 思考 / MiniMax 合成中…';
  state.stream.sendInputText(text);
  try {
    const started = performance.now();
    const result = await api('/api/turn', { live_id: state.live.id, text, history: state.history.slice(-20) }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (version !== state.turnVersion || !state.stream?.ready) return;
    state.history.push({ role: 'user', content: text }, { role: 'assistant', content: result.text }); state.history = state.history.slice(-20);
    addMessage('assistant', result.text);
    element('llmStatus').textContent = '调用成功'; element('minimaxStatus').textContent = '合成成功';
    element('subtitle').textContent = result.text; element('subtitle').hidden = false;
    element('turnStatus').textContent = '主播播报中…';
    log(`回复生成 ${(performance.now() - started).toFixed(0)}ms；音频 ${Math.round(result.duration_ms)}ms`);
    if (!state.stream.sendOutputText(result.text)) throw new Error('回复文本发送失败');
    await sendPcm(state.stream, decodePcm(result.audio), controller.signal);
    element('turnStatus').textContent = '可以继续说';
  } catch (error) {
    if (version === state.turnVersion) { state.stream?.interrupt(); element('turnStatus').textContent = error.name === 'AbortError' ? '已打断' : '本轮失败，可重新发送'; element('subtitle').hidden = true; }
    report(error);
  } finally { if (version === state.turnVersion) { state.busy = false; state.turnAbort = null; controls(); } }
}

async function loadMonet() {
  state.monetManifest = await api('/api/monet');
  element('monetPersona').value = state.monetManifest.persona;
  element('monetAction').replaceChildren();
  for (const action of state.monetManifest.actions) element('monetAction').appendChild(new Option(`${action.category} · ${action.name}`, action.id));
  const requirements = [...new Set(state.monetManifest.actions.flatMap(action => action.requires || []))];
  const labels = state.monetManifest.requirement_labels || {};
  element('monetRequirements').replaceChildren();
  for (const requirement of requirements) {
    const label = document.createElement('label'); const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.value = requirement;
    label.append(checkbox, document.createTextNode(labels[requirement] || requirement));
    element('monetRequirements').appendChild(label);
  }
}

async function prepareMonetLibrary() {
  element('monetStatus').textContent = '首次开播：正在准备专属动作库（50个动作＋欢迎、告别），可能需要几分钟；不会重复创建。';
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const progress = await api('/api/monet/library');
      if (progress.busy) element('monetStatus').textContent = `正在准备专属动作库 ${progress.completed}/${progress.total}，尚未创建付费直播…`;
    } catch { }
    finally { polling = false; }
  }, 2000);
  try {
    const ready = await api('/api/monet/library', {});
    if (!ready.ready) throw new Error('动作库准备未完成');
    element('monetStatus').textContent = '专属动作库已准备，正在连接S2；动作实际效果仍待真实画面验收。';
  } finally { clearInterval(timer); }
}

function maybeWelcomeMonet() {
  if (state.running && state.mediaProof && state.monet && !state.monet.opened) state.monet.start().catch(report);
}

async function waitForLiveFrames(userId, signal, deadlineMs = 20000) {
  const deadline = performance.now() + deadlineMs;
  let previousVideo = null; let previousTime = 0;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    if (!state.running || !state.stream?.ready) throw new Error('直播已断开，停止试演');
    if (state.editingError && state.editing?.output_user_id === userId) throw new Error(state.editingError);
    const video = [...element('videoHost').querySelectorAll('video')].find(item => item.readyState >= 2 && item.videoWidth > 0 && !item.paused);
    if (state.mediaProof?.userId === userId && video) {
      if (previousVideo === video && video.currentTime - previousTime >= 0.12) return { user_id: userId, width: video.videoWidth, height: video.videoHeight };
      if (previousVideo !== video) { previousVideo = video; previousTime = video.currentTime; }
    }
    await abortableDelay(100, signal);
  }
  throw new Error('未收到目标流的持续视频帧，试演停止；不把静态预览判为通过');
}

function createMonetDirector() {
  return new MonetDirector({
    actions: state.monetManifest.actions,
    idleMs: Number(element('monetIdle').value),
    availableRequirements: () => [...element('monetRequirements').querySelectorAll('input:checked')].map(input => input.value),
    prepare: async (input, signal) => {
      element('turnStatus').textContent = input.event === 'action' ? '准备动作…' : '莫奈正在想怎么回应你…';
      const available = [...element('monetRequirements').querySelectorAll('input:checked')].map(item => item.value);
      const result = await api('/api/monet/turn', { ...input, live_id: state.live.id, history: state.history.slice(-20), available_requirements: available }, { signal });
      return { ...result, user_text: input.event === 'turn' ? input.text : '' };
    },
    perform: performMonet,
    changeScene: async signal => {
      const reference = state.outfits.find(item => item.id === element('monetBackground').value && item.kind === 'reference');
      if (!reference) throw new Error('先上传宏大幻想场景参考图，并在莫奈素材设置中选中它；没有虚构文生背景接口');
      while (state.editingBusy) await abortableDelay(100, signal);
      signal.throwIfAborted();
      selectReference(reference); element('editingType').value = 'background_replacement';
      await applyEditing();
      signal.throwIfAborted();
      if (!state.editing) throw new Error('Editing未建立，无法演示背景切换');
      const editingId = state.editing.live.id;
      await abortableDelay(3000, signal);
      if (state.editing?.live.id !== editingId) throw new Error('Editing连接已变化，停止本次场景演示');
      return waitForLiveFrames(state.editing.output_user_id, signal);
    },
    interrupt: () => interrupt(false),
    onState: director => {
      state.busy = director.busy;
      if (!director.busy && director.active) element('turnStatus').textContent = director.closed ? '本次交流已结束，等待下一位访客' : '莫奈在听，继续聊聊吧';
      controls();
    },
    onEvent: entry => {
      if (entry.event === 'progress') element('monetStatus').textContent = `动作试演 ${entry.index}/${entry.total} · ${entry.name}`;
      else if (entry.event === 'prepared') element('monetStatus').textContent = `正在表演 · ${entry.intent} · 动作和口播独立控制`;
      else if (entry.event === 'submitted') element('monetStatus').textContent = '本段已发送并接收到视频帧；动作准确性与自然度待看画面验收。';
      else if (entry.event === 'failed') element('monetStatus').textContent = `本轮停止：${entry.message}`;
      else if (entry.event === 'cancelled' || entry.event === 'stopped') element('monetStatus').textContent = '试演已停止。原直播需点击「结束直播」关闭。';
      log(`莫奈 · ${entry.event}${entry.name ? ` · ${entry.name}` : ''}${entry.reason ? ` · ${entry.reason}` : ''}`, entry.event === 'failed' ? 'err' : '');
      element('monetExport').disabled = false;
    },
    onError: report,
  });
}

async function performMonet(result, signal) {
  await waitForLiveFrames(state.editing?.output_user_id || state.pushUserId, signal);
  signal.throwIfAborted();
  let action = result.action;
  if (result.action_unavailable) state.monet.note('skipped', { action_id: result.action_unavailable, reason: `未确认素材条件：${result.missing_requirements.join('、')}` });
  if (action && !result.action_explicit && result.intent !== 'action' && performance.now() - state.lastGestureAt < 12000) {
    state.monet.note('gesture_suppressed', { action_id: action.id, reason: '轻动作冷却，避免每句话都表演' }); action = null;
  }
  state.actionError = null;
  if (action) {
    if (!state.stream.sendAction(action.name)) throw new Error('S2动作提示发送失败');
    state.lastGestureAt = performance.now();
    state.monet.note('action_sent', { action_id: action.id, name: action.name, signal_type: 9, visual_verdict: 'pending_review' });
  }
  if (result.user_text) {
    state.history.push({ role: 'user', content: result.user_text });
  }
  const started = performance.now();
  if (result.text) {
    addMessage('assistant', result.text);
    state.history.push({ role: 'assistant', content: result.text }); state.history = state.history.slice(-20);
    element('subtitle').textContent = result.text; element('subtitle').hidden = false;
    element('turnStatus').textContent = '莫奈正在回应…';
    if (result.needs_llm) element('llmStatus').textContent = '自然对话生成成功';
    element('minimaxStatus').textContent = '合成成功';
    if (!state.stream.sendOutputText(result.text)) throw new Error('莫奈口播文本发送失败');
    await sendPcm(state.stream, decodePcm(result.audio), signal);
  } else if (action) {
    await sendPcm(state.stream, new Uint8Array(action.hold_ms * 48), signal);
  }
  const remaining = Math.max(1200, (action?.hold_ms || 0) - (performance.now() - started));
  await abortableDelay(remaining, signal);
  if (state.actionError) throw new Error(state.actionError);
  await waitForLiveFrames(state.editing?.output_user_id || state.pushUserId, signal);
  element('subtitle').hidden = true;
}

function runMonet(event, actionId) {
  if (!state.monet?.active) return toast('请先选择莫奈模式并开始直播', true);
  if (event === 'demo' && !element('monetBackground').value) {
    element('monetDetails').open = true;
    return toast('完整演示需先上传并选择一张背景参考图', true);
  }
  if (event === 'opening' || event === 'demo') state.history = [];
  state.monet.run({ event, ...(actionId ? { action_id: actionId } : {}) }).catch(report);
}

function exportMonetReport() {
  if (!state.monet) return;
  const reportData = { ...state.monet.report(), avatar_name: state.selected?.name, background_name: state.outfits.find(item => item.id === element('monetBackground').value)?.name };
  const url = URL.createObjectURL(new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'monet-performance-report.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleRecognition() {
  if (state.recognition) { stopRecognition(); return; }
  const Constructor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Constructor) { toast('浏览器不支持语音识别，请使用文字输入', true); return; }
  const recognition = new Constructor(); recognition.lang = 'zh-CN'; recognition.continuous = true; recognition.interimResults = true;
  state.recognition = recognition;
  recognition.onspeechstart = () => { if (state.busy) interrupt(); };
  recognition.onresult = event => {
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const text = event.results[index][0]?.transcript?.trim();
      if (!text) continue;
      if (event.results[index].isFinal) {
        // 语音转写 → 互动引擎（意图分类 + 双轨输出），中控台提供派发钩子
        if (window.__consoleActive && window.__consoleDispatch) {
          addMessage('user', text);
          element('turnStatus').textContent = '互动引擎处理中…';
          fetch('/api/interaction/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'comment', text }) })
            .then(response => response.json())
            .then(result => {
              if (result.dropped) { element('turnStatus').textContent = `调度器已过滤该条弹幕`; return; }
              if (result.queued) { element('turnStatus').textContent = '主播播报中，已进入提问队列'; return; }
              if (result.plan) window.__consoleDispatch(result.plan);
            })
            .catch(error => report(error));
        }
        else sendTurn(text).catch(report);
      }
      else { state.monet?.clearIdle(); element('turnStatus').textContent = `听到：${text}`; }
    }
  };
  recognition.onerror = event => { if (!['no-speech', 'aborted'].includes(event.error)) { toast(`语音识别失败：${event.error}，可改用文字`, true); stopRecognition(); } };
  recognition.onend = () => { if (state.recognition === recognition && state.running) { try { recognition.start(); } catch { stopRecognition(); } } };
  try { recognition.start(); element('micButton').textContent = '关闭语音输入'; element('micButton').setAttribute('aria-pressed', 'true'); toast('语音输入已开启，建议佩戴耳机避免回声'); }
  catch (error) { stopRecognition(); report(error); }
}

element('settingsButton').onclick = () => openSettings().catch(report);
if (new URLSearchParams(location.search).get('experience') === 'monet') element('experience').value = 'monet';
element('monetDemo').onclick = () => runMonet('demo');
element('monetMatrix').onclick = () => runMonet('matrix');
element('monetVisitor').onclick = () => runMonet('opening');
element('monetClosing').onclick = () => runMonet('closing');
element('monetActionRun').onclick = () => runMonet('action', element('monetAction').value);
element('monetCancel').onclick = () => interrupt();
element('monetExport').onclick = exportMonetReport;
async function useMonetAvatar() {
  element('monetAvatar').disabled = true;
  try {
    const imported = await api('/api/monet/avatar', {});
    await loadOutfits(); selectOutfit(imported);
    element('experience').value = 'monet';
    for (const checkbox of element('monetRequirements').querySelectorAll('input')) checkbox.checked = imported.confirmed_requirements.includes(checkbox.value);
    toast('已载入原公开人物图；不含脚部，默认跳过全身与道具动作');
  } catch (error) { report(error); }
  finally { controls(); }
}
element('monetAvatar').onclick = useMonetAvatar;
element('chatInput').addEventListener('input', () => state.monet?.clearIdle());
element('experience').addEventListener('change', () => { document.querySelector('.monet-panel').hidden = element('experience').value !== 'monet'; });
element('settingsForm').onsubmit = saveSettings;
element('rtcProvider').onchange = fillRtcFields;
for (const id of ['closeSettings', 'cancelSettings']) element(id).onclick = () => element('settingsDialog').close();
element('settingsDialog').addEventListener('close', () => { for (const input of element('settingsDialog').querySelectorAll('input[type=password]')) input.value = ''; });
element('stageUpload').onclick = () => element('avatarFile').click();
element('avatarFile').onchange = async event => { element('avatarFile').disabled = true; try { await importImage(event.target.files[0]); } catch (error) { report(error); } finally { element('avatarFile').disabled = false; element('avatarFile').value = ''; } };
element('referenceFile').onchange = async event => { element('referenceFile').disabled = true; try { await importImage(event.target.files[0], 'reference'); } catch (error) { report(error); } finally { element('referenceFile').disabled = false; element('referenceFile').value = ''; } };
element('referenceSelect').onchange = () => selectReference(state.outfits.find(outfit => outfit.id === element('referenceSelect').value) || null);
element('editingButton').onclick = () => applyEditing().catch(report);
element('stopEditing').onclick = () => stopEditing().catch(report);
element('confirmEditing').onclick = () => { element('editingStatus').textContent = '你已确认当前换装画面。可上传新参考图继续切换。'; element('confirmEditing').hidden = true; };
element('closeOutfit').onclick = () => element('outfitDialog').close();
element('applyOutfit').onclick = async () => {
  const candidate = state.candidate;
  const personaId = element('outfitPersona').value || null;
  const reconnect = state.running;
  element('outfitDialog').close();
  try {
    if (personaId !== (candidate.persona_id || null)) {
      await api(`/api/outfits/${candidate.id}/bind`, { persona_id: personaId });
      candidate.persona_id = personaId || '';
      await loadOutfits();
      toast(personaId ? `已绑定人设：${state.personaOptions.find(p => p.id === personaId)?.name || personaId}` : '已解除人设绑定');
    }
    await switchPersonaIfNeeded(personaId);
    if (reconnect) await stop(); selectOutfit(state.outfits.find(item => item.id === candidate.id) || candidate); if (reconnect) await start(); else toast('出镜形象已选择');
  } catch (error) { report(error); }
};
element('deleteOutfit').onclick = async () => {
  try { const id = state.candidate.id; await api(`/api/outfits/${id}`, undefined, { method: 'DELETE' }); if (state.selected?.id === id) selectOutfit(null); await loadOutfits(); element('outfitDialog').close(); toast('造型已删除'); } catch (error) { report(error); }
};
element('startButton').onclick = () => start().catch(report);
element('stopButton').onclick = () => stop().catch(report);
element('interruptButton').onclick = interrupt;
element('micButton').onclick = toggleRecognition;
element('fullscreenButton').onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(report); else element('stage').requestFullscreen().catch(report); };

function setCanvasMode(active) {
  document.body.classList.toggle('canvas-mode', active);
  element('canvasExit').hidden = !active;
  element('canvasButton')?.classList.toggle('active', active);
  try { localStorage.setItem('s2_canvas_mode', active ? '1' : '0'); } catch { /* 忽略 */ }
}
element('canvasButton')?.addEventListener('click', () => setCanvasMode(!document.body.classList.contains('canvas-mode')));
element('canvasExit').addEventListener('click', () => setCanvasMode(false));
if (localStorage.getItem('s2_canvas_mode') === '1') setCanvasMode(true);
pushDanmaku('欢迎来到直播间，发条弹幕聊聊吧', '系统');

/* 录屏：默认锁定当前标签页（preferCurrentTab，无需手动选其它屏幕）。
   声音来自「标签页音频」（数字人声音在页面内播放，勾选后即可录到）；
   Chrome/Edge 126+ 的 MediaRecorder 直接输出 MP4（h264+aac），老浏览器
   先录 webm 再自动上传服务端 ffmpeg 转码为 MP4 后下载。 */
const MP4_MIMES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=h264,aac', 'video/mp4'];
const WEBM_MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function toggleRecording() {
  if (state.recorder?.state === 'recording') { state.recorder.stop(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持录屏，请使用 Chrome / Edge');
  const capture = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: true,        // 默认预选当前 S2 直播页
    selfBrowserSurface: 'include', // 允许录制本页自身
    systemAudio: 'include',        // 附带系统音频（整屏分享时）
  });
  if (!capture.getAudioTracks().length) {
    capture.getTracks().forEach(track => track.stop());
    throw new Error('没有录到声音：请在分享弹窗展开后勾选「同时分享标签页音频」，再重新开始录屏');
  }
  const mime = [...MP4_MIMES, ...WEBM_MIMES].find(type => window.MediaRecorder?.isTypeSupported(type)) || '';
  const nativeMp4 = Boolean(mime && mime.startsWith('video/mp4'));
  const chunks = [];
  const recorder = new MediaRecorder(capture, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = async () => {
    capture.getTracks().forEach(track => track.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    state.recorder = null;
    controls();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (nativeMp4) {
      saveBlob(blob, `s2-live-${stamp}.mp4`);
      toast(`录屏已保存 MP4（含声音，${(blob.size / 1048576).toFixed(1)}MB）`);
      return;
    }
    /* 老浏览器：webm → 上传 → 服务端 ffmpeg 转码 MP4 → 下载 */
    toast('录屏完成 · 服务端转码 MP4 中…');
    try {
      const upload = await fetch('/api/video/upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(`s2-live-${stamp}.webm`) }, body: blob });
      if (!upload.ok) throw new Error(`上传失败 HTTP ${upload.status}`);
      const meta = await upload.json();
      const conv = await api('/api/media/transcode', { file: meta.url });
      const mp4 = await fetch(conv.url);
      if (!mp4.ok) throw new Error(`下载失败 HTTP ${mp4.status}`);
      const mp4Blob = await mp4.blob();
      saveBlob(mp4Blob, `s2-live-${stamp}.mp4`);
      toast(`录屏已转码保存 MP4（含声音，${(mp4Blob.size / 1048576).toFixed(1)}MB）`);
    } catch (error) {
      saveBlob(blob, `s2-live-${stamp}.webm`);
      report(new Error(`MP4 转码未成功，已保存 webm 原片：${error.message}`));
    }
  };
  capture.getVideoTracks()[0].onended = () => { if (recorder.state === 'recording') recorder.stop(); };
  state.recorder = recorder;
  controls();
  recorder.start(1000);
  toast('录屏中 · 默认录制当前直播页（含主播声音；若弹窗有「分享标签页音频」请保持勾选）');
}
element('recordButton').onclick = () => toggleRecording().catch(error => { state.recorder = null; controls(); report(error); });
element('chatForm').onsubmit = event => {
  event.preventDefault();
  const text = element('chatInput').value.trim();
  if (!text || state.busy) return;
  element('chatInput').value = '';
  // 中控台开启时聊天也走互动引擎（与语音一致），否则走基础对话
  if (window.__consoleActive && window.__consoleDispatch) {
    addMessage('user', text);
    api('/api/interaction/event', { type: 'comment', text })
      .then(result => {
        if (result.dropped) { element('turnStatus').textContent = '调度器已过滤该条弹幕'; return; }
        if (result.queued) { element('turnStatus').textContent = '主播播报中，已进入提问队列'; return; }
        if (result.plan) window.__consoleDispatch(result.plan);
      })
      .catch(report);
  }
  else sendTurn(text).catch(report);
};
element('chatInput').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); element('chatForm').requestSubmit(); } };
element('voicePreview').onclick = async () => {
  stopVoicePreview();
  const controller = new AbortController(); state.previewAbort = controller;
  state.previewBusy = true; controls();
  try {
    const result = await api('/api/voice/preview', { text: '你好，欢迎来到我的直播间。今天想和我聊些什么？' }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    state.previewUrl = URL.createObjectURL(pcmWav(decodePcm(result.audio)));
    state.previewAudio = new Audio(state.previewUrl);
    state.previewAudio.onended = stopVoicePreview;
    await state.previewAudio.play(); toast('正在播放MiniMax真实合成音色');
  } catch (error) { stopVoicePreview(); report(error); }
  finally { state.previewBusy = false; controls(); }
};
function stopVoicePreview() {
  state.previewAbort?.abort(); state.previewAbort = null;
  state.previewAudio?.pause(); state.previewAudio = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null; state.previewBusy = false;
}
/* 3D 视差：全局 mousemove → 弹簧平滑 → 分层位移 CSS 变量（装饰层用，不影响功能布局） */
function setupParallax() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  let running = false;
  const step = () => {
    current.x += (target.x - current.x) * 0.08;   // 低通滤波近似弹簧，位移平滑无跳变
    current.y += (target.y - current.y) * 0.08;
    root.style.setProperty('--px', current.x.toFixed(4));
    root.style.setProperty('--py', current.y.toFixed(4));
    if (Math.abs(target.x - current.x) + Math.abs(target.y - current.y) > 0.001) requestAnimationFrame(step);
    else running = false;
  };
  window.addEventListener('mousemove', event => {
    target.x = event.clientX / window.innerWidth - 0.5;
    target.y = event.clientY / window.innerHeight - 0.5;
    if (!running) { running = true; requestAnimationFrame(step); }
  }, { passive: true });
  // 视差装饰层：三团光晕按深度分层漂移（前景幅度最大、背景几乎静止）
  const layer = document.createElement('div');
  layer.className = 'parallax-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<div class="orb orb-a"></div><div class="orb orb-b"></div><div class="orb orb-c"></div>';
  document.body.appendChild(layer);
}
setupParallax();

window.addEventListener('pagehide', () => {
  state.monet?.stop();
  state.turnAbort?.abort(); state.stream?.close(); state.editingStream?.close(); stopRecognition(); stopVoicePreview();
  if (state.live) fetch(`/api/live/${state.live.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
});
Promise.all([loadConfig(), loadOutfits(), loadMonet()]).then(async () => {
  renderLookStrip();
  if (element('experience').value === 'monet') await useMonetAvatar();
  controls(); log('云端工作台已就绪；尚未创建直播');
}).catch(report);

/* V2 中控台桥接：对话轨（口播+PCM）与画面轨（动作/换装信令）复用直播工作台既有通道。
 * speakOut 可传第三个参数 subtitleText：音频里的拟声标签（如(laughs)）不应出现在 S2 上行口播与字幕中 */
async function speakOut(text, audioBase64, subtitleText) {
  if (!state.stream?.ready) throw new Error('直播未连接，无法播报');
  // 只有上一段还在播时才需要 type 7；空闲开新段时发 interrupt 会让 S2 多一次无意义复位。
  if (state.speaking) interrupt(false);
  state.speaking = true;
  const subtitle = subtitleText || text;
  if (!state.stream.sendOutputText(subtitle)) { state.speaking = false; throw new Error('口播文本发送失败'); }
  element('subtitle').textContent = subtitle; element('subtitle').hidden = false;
  try {
    await sendPcm(state.stream, decodePcm(audioBase64), undefined, undefined, undefined, PCM_FRAME_BYTES);
  } finally {
    state.speaking = false;
    element('subtitle').hidden = true;
  }
}
window.S2Bridge = {
  isReady: () => Boolean(state.stream?.ready),
  isRunning: () => state.running,
  speakOut,
  // 礼物即时动效：叠在直播画面上的轻量全屏特效（不依赖离线任务，零延迟）
  giftOverlay: (giftName, tier, iconOverride) => {
    const stage = element('stageLive') || element('stage');
    stage.querySelector('.gift-pop')?.remove();
    const icon = iconOverride || (tier === 'high' ? '🚀' : tier === 'mid' ? '💎' : '❤️');
    const pop = document.createElement('div');
    pop.className = `gift-pop tier-${tier || 'low'}`;
    pop.innerHTML = `<span class="gift-icon">${icon}</span><b>${giftName || '礼物'}</b>`;
    stage.appendChild(pop);
    setTimeout(() => pop.remove(), 2600);
  },
  sendAction: (name, options) => state.stream?.sendAction(name, options) || false,
  editingReady: () => Boolean(state.editingStream?.ready),
  switchPrompt: (image, type) => state.editingStream?.switchPrompt(image, type) || false,
  referenceImage: async () => {
    if (!state.reference) return null;
    const result = await api(`/api/outfits/${state.reference.id}/reference`);
    return result.image_uri;
  },
  avatarImage: async () => state.selected ? (await api(`/api/outfits/${state.selected.id}/reference`)).image_uri : null,
  // 人设切换 → 套装形象同步：未开播直接选中；直播中提示去造型库一键应用（重连式换装有确认）
  applyOutfit: async outfit => {
    let target = state.outfits.find(item => item.id === outfit.id);
    if (!target) { await loadOutfits(); target = state.outfits.find(item => item.id === outfit.id); }
    if (!target || state.selected?.id === target.id) return Boolean(target);
    if (state.running || state.starting) { toast(`该人设绑定形象「${target.name}」，在造型库点击应用即可换装`, true); return false; }
    selectOutfit(target);
    toast(`已同步人设形象：${target.name}`);
    return true;
  },
  addMessage,
  log,
  toast,
  // 唱歌/离线MV：中控台直接取底层 WS 流（推音乐 PCM、type=16 切换形象）
  stream: () => state.stream,
  liveActive: () => Boolean(state.running && state.stream?.ready),
};
