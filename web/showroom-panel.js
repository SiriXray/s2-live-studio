/**
 * 样板间：行业最佳实践 + 场景 / 人物 / 话术 / 动作自由组合。
 * 只负责选择与预览；应用后由 /api/showroom/apply 写入控制台配置。
 */
const $ = id => document.getElementById(id);
let catalog = null;
let outfits = [];
let selectedScene = 'living_room';
let selectedIndustry = 'social';

function status(text, error = false) {
  const node = $('showroomStatus');
  node.hidden = !text;
  node.textContent = text || '';
  node.classList.toggle('error-text', error);
}

function currentScript() {
  return catalog?.scripts.find(item => item.id === $('showroomScript').value) || null;
}

function currentAction() {
  return catalog?.actions.find(item => item.id === $('showroomAction').value) || null;
}

const PEOPLE = [
  { industry: 'social', scene: 'living_room', persona: 'tender_companion', script: 'social_5', action: 'natural', name: '温柔陪伴', meta: '社交直播 · 深夜客厅', image: '/showroom/avatars/social.jpg' },
  { industry: 'social', scene: 'living_room', persona: 'sweet_energy', script: 'social_5', action: 'natural', name: '甜美元气', meta: '社交直播 · 甜心互动', image: '/showroom/avatars/sweet.jpg' },
  { industry: 'social', scene: 'living_room', persona: 'funny_playful', script: 'social_5', action: 'lively', name: '搞笑俏皮', meta: '社交直播 · 轻松整活', image: '/showroom/avatars/funny.jpg' },
  { industry: 'education', scene: 'scholar', persona: 'elegant_edu', script: 'education_20', action: 'education', name: '知性讲师', meta: '教育 · 知识书房', image: '/showroom/avatars/education.jpg' },
  { industry: 'commerce', scene: 'market', persona: 'hype_sales', script: 'commerce_5', action: 'commerce', name: '活力带货', meta: '带货 · 卖场直播', image: '/showroom/avatars/commerce.jpg' },
  { industry: 'local', scene: 'kitchen', persona: 'lively_rural', script: 'local_5', action: 'lively', name: '生活主理人', meta: '本地生活 · 田园厨房', image: '/showroom/avatars/local.jpg' },
  { industry: 'gaming', scene: 'palace', persona: 'npc_gui_fei', script: 'npc_scene', action: 'stage', name: '宫宴角色', meta: '影游互动 · 影游宫宴', image: '/showroom/avatars/gaming.jpg' },
  { industry: 'gaming', scene: 'palace', persona: 'npc_qing_dai', script: 'npc_scene', action: 'stage', name: '古风侍女', meta: '影游互动 · 宫宴侍女', image: '/showroom/avatars/qing.jpg' },
  { industry: 'music', scene: 'stage', persona: 'velvety_night', script: 'music_5', action: 'natural', name: '磁性电台', meta: '音乐电台 · 音乐舞台', image: '/showroom/avatars/music.jpg' },
  { industry: 'music', scene: 'stage', persona: 'cool_queen', script: 'music_5', action: 'natural', name: '高冷御姐', meta: '音乐电台 · 冷感舞台', image: '/showroom/avatars/cool.jpg' },
];

function renderPeople() {
  const host = $('showroomPeople');
  if (!host) return;
  host.replaceChildren();
  for (const person of PEOPLE) {
    const card = document.createElement('div');
    card.className = 'showroom-person';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${person.name}，${person.meta}`);
    const image = document.createElement('img');
    image.src = person.image;
    image.alt = person.name;
    image.loading = 'eager';
    image.onerror = () => { image.style.display = 'none'; };
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'sp-start';
    start.textContent = '开播';
    start.onclick = event => { event.stopPropagation(); applyPerson(person, true); };
    const info = document.createElement('div');
    info.className = 'sp-info';
    const name = document.createElement('div');
    name.className = 'sp-name';
    name.textContent = person.name;
    const meta = document.createElement('div');
    meta.className = 'sp-meta';
    meta.textContent = person.meta;
    info.append(name, meta);
    card.append(image, start, info);
    card.onclick = () => applyPerson(person, false);
    card.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); applyPerson(person, false); }
    };
    host.appendChild(card);
  }
}

async function applyPerson(person, startAfter) {
  const industry = catalog?.industries.find(item => item.id === person.industry);
  selectedIndustry = person.industry;
  selectedScene = person.scene;
  $('showroomPersona').value = person.persona;
  $('showroomScript').value = person.script;
  $('showroomAction').value = person.action;
  $('showroomOpening').value = currentScript()?.opening || '';
  setParams(industry?.params || {});
  renderIndustries();
  renderScenes();
  status(`已选人物：${person.name} · ${person.meta}`);
  return apply(startAfter);
}


function renderIndustries() {
  const host = $('showroomIndustries');
  host.replaceChildren();
  for (const industry of catalog.industries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `showroom-industry${industry.id === selectedIndustry ? ' active' : ''}`;
    const title = document.createElement('b');
    title.textContent = `${industry.icon} ${industry.name}`;
    const desc = document.createElement('small');
    desc.textContent = industry.tagline;
    button.append(title, desc);
    button.onclick = () => applyIndustry(industry);
    host.appendChild(button);
  }
}

function renderScenes() {
  const host = $('showroomScenes');
  host.replaceChildren();
  for (const scene of catalog.scenes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `showroom-scene${scene.id === selectedScene ? ' active' : ''}`;
    const image = document.createElement('img');
    image.src = scene.image;
    image.alt = scene.name;
    image.loading = 'lazy';
    image.onerror = () => { image.style.display = 'none'; };
    const label = document.createElement('span');
    label.textContent = `${scene.name} · ${scene.subtitle}`;
    button.append(image, label);
    button.onclick = () => {
      selectedScene = scene.id;
      renderScenes();
      status(`场景：${scene.name} · ${scene.prompt}（人物与形象独立，可在上方单独选人物）`);
    };
    host.appendChild(button);
  }
}

function renderOptions() {
  const personaSelect = $('showroomPersona');
  personaSelect.replaceChildren();
  for (const persona of catalog.personas) {
    const option = document.createElement('option');
    option.value = persona.id;
    option.textContent = `${persona.name} · ${persona.category || ''}`;
    personaSelect.appendChild(option);
  }

  const scriptSelect = $('showroomScript');
  scriptSelect.replaceChildren();
  for (const script of catalog.scripts) {
    const option = document.createElement('option');
    option.value = script.id;
    option.textContent = `${script.name} · ${script.industry}`;
    scriptSelect.appendChild(option);
  }

  const actionSelect = $('showroomAction');
  actionSelect.replaceChildren();
  for (const action of catalog.actions) {
    const option = document.createElement('option');
    option.value = action.id;
    option.textContent = `${action.name} · ${action.desc}`;
    actionSelect.appendChild(option);
  }
}

function setParams(triggers = {}) {
  $('showroomSilence').value = Number(triggers.silence_s ?? 45);
  $('showroomIdle').value = Number(triggers.idle_motion_s ?? 8);
  $('showroomSmalltalk').value = Number(triggers.smalltalk_probability ?? 0.85);
}

function applyIndustry(industry) {
  selectedIndustry = industry.id;
  const recommended = industry.recommended;
  selectedScene = recommended.scene_id;
  $('showroomPersona').value = recommended.persona_id;
  $('showroomScript').value = recommended.script_id;
  $('showroomAction').value = recommended.action_id;
  $('showroomOpening').value = currentScript()?.opening || '';
  setParams(industry.params);
  renderIndustries();
  renderScenes();
  status(`${industry.name}：${industry.tagline}`);
}

function syncFromState(state) {
  selectedIndustry = state.industry_id || 'social';
  selectedScene = state.scene_id || 'living_room';
  $('showroomPersona').value = state.persona_id;
  $('showroomScript').value = state.script_id;
  $('showroomAction').value = state.action_id;
  $('showroomOpening').value = state.opening || '';
  setParams(state.triggers || {});
  renderIndustries();
  renderScenes();
}

async function apply(startAfter = false) {
  if (!catalog) return false;
  let applied = false;
  const payload = {
    industry_id: selectedIndustry,
    scene_id: selectedScene,
    persona_id: $('showroomPersona').value,
    script_id: $('showroomScript').value,
    action_id: $('showroomAction').value,
    opening: $('showroomOpening').value.trim(),
    triggers: {
      silence_s: Number($('showroomSilence').value),
      idle_motion_s: Number($('showroomIdle').value),
      smalltalk_probability: Number($('showroomSmalltalk').value),
    },
  };
  const button = $('showroomApply');
  button.disabled = true;
  status('正在写入控制台…');
  try {
    const response = await fetch('/api/showroom/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.showroom) syncFromState(data.showroom);
    const script = currentScript();
    const scene = catalog.scenes.find(item => item.id === selectedScene);
    const outfit = outfits.find(item => item.name === scene?.outfit_name);
    let sceneNote = outfit ? '' : '；场景参考已应用，出镜形象请在造型库选择';
    if (outfit) {
      if (window.S2Bridge?.isRunning?.()) {
        sceneNote = `；直播中换场景请到造型库应用「${outfit.name}」`;
      } else {
        try {
          await window.S2Bridge?.applyOutfit?.(outfit);
          sceneNote = `；已切换场景形象「${outfit.name}」`;
        } catch {
          sceneNote = `；场景形象「${outfit.name}」需在造型库手动应用`;
        }
      }
    }
    status(`已应用：${script?.name || ''} · ${currentAction()?.name || ''} · 场景 ${scene?.name || selectedScene}${sceneNote}`);
    window.dispatchEvent(new CustomEvent('showroom-applied', { detail: data }));
    applied = true;
  } catch (error) {
    status(`应用失败：${error.message}`, true);
    return false;
  } finally {
    button.disabled = false;
  }
  if (applied && startAfter) {
    if (window.S2Bridge?.isRunning?.()) {
      status('当前已在直播中，人物与话术已应用');
      return true;
    }
    status('已应用，正在开播…');
    try {
      await window.S2Bridge?.startLive?.();
    } catch (error) {
      status(`应用成功，但开播失败：${error.message}`, true);
      return false;
    }
  }
  return applied;
}

async function tryActions() {
  const bridge = window.S2Bridge;
  const action = currentAction();
  if (!bridge?.isRunning?.()) { status('先开始直播，再试动作', true); return; }
  if (!action) return;
  const group = action.groups.silence || action.groups.greet || [];
  if (!group.length) { status('当前动作模板没有可试动作', true); return; }
  status(`试动作：${group.slice(0, 2).join(' / ')}`);
  for (const name of group.slice(0, 2)) {
    bridge.sendAction(name);
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}

async function load() {
  if (!$('showroomIndustries')) return;
  try {
    const [response, outfitResponse] = await Promise.all([
      fetch('/api/showroom'),
      fetch('/api/outfits').catch(() => null),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalog = await response.json();
    outfits = outfitResponse?.ok ? (await outfitResponse.json()).items || [] : [];
    renderOptions();
    renderPeople();
    syncFromState(catalog.state);
    status(`当前：${catalog.state.persona_id} · ${catalog.state.script_id} · ${catalog.state.action_id}`);
  } catch (error) {
    status(`样板间加载失败：${error.message}`, true);
  }
  $('showroomApply').onclick = () => apply();
  $('showroomTry').onclick = () => tryActions();
  $('showroomScript').onchange = () => {
    const script = currentScript();
    if (script) $('showroomOpening').value = script.opening;
  };
}

load();

const showroomNav = document.getElementById('showroomNav');
if (showroomNav) {
  showroomNav.addEventListener('click', () => {
    const drawer = document.getElementById('consoleDrawer');
    if (drawer?.hidden) document.getElementById('consoleButton')?.click();
    setTimeout(() => document.getElementById('csShowroom')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
  });
}
