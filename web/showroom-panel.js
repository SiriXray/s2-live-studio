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
      const persona = scene.id === 'scholar' ? 'elegant_edu' : scene.id === 'market' ? 'hype_sales' : scene.id === 'palace' ? 'npc_gui_fei' : scene.id === 'kitchen' ? 'lively_rural' : scene.id === 'stage' ? 'velvety_night' : 'tender_companion';
      if ([...$('showroomPersona').options].some(option => option.value === persona)) $('showroomPersona').value = persona;
      status(`场景：${scene.name} · ${scene.prompt}`);
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

async function apply() {
  if (!catalog) return;
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
  } catch (error) {
    status(`应用失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
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
