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
  { industry: 'social', scene: 'living_room', persona: 'tender_companion', script: 'social_5', action: 'natural', name: '温柔陪伴', meta: '社交直播 · 深夜客厅', image: '/showroom/avatars/social.jpg', outfit: '样板间·温柔陪伴', voice: 'female_tender_e' },
  { industry: 'social', scene: 'living_room', persona: 'sweet_energy', script: 'social_5', action: 'natural', name: '甜美元气', meta: '社交直播 · 甜心互动', image: '/showroom/avatars/sweet.jpg', outfit: '样板间·甜美元气', voice: 'female_lively_d' },
  { industry: 'social', scene: 'living_room', persona: 'funny_playful', script: 'social_5', action: 'lively', name: '搞笑俏皮', meta: '社交直播 · 轻松整活', image: '/showroom/avatars/funny.jpg', outfit: '样板间·搞笑俏皮', voice: 'male_low_a' },
  { industry: 'education', scene: 'scholar', persona: 'elegant_edu', script: 'education_20', action: 'education', name: '知性讲师', meta: '教育 · 知识书房', image: '/showroom/avatars/education.jpg', outfit: '样板间·知性讲师', voice: 'female_scholar_g' },
  { industry: 'commerce', scene: 'market', persona: 'hype_sales', script: 'commerce_5', action: 'commerce', name: '活力带货', meta: '带货 · 卖场直播', image: '/showroom/avatars/commerce.jpg', outfit: '样板间·活力带货', voice: 'female_bright_h' },
  { industry: 'local', scene: 'kitchen', persona: 'lively_rural', script: 'local_5', action: 'lively', name: '生活主理人', meta: '本地生活 · 田园厨房', image: '/showroom/avatars/local.jpg', outfit: '样板间·生活主理人', voice: 'female_lively_d' },
  { industry: 'gaming', scene: 'palace', persona: 'npc_gui_fei', script: 'npc_scene', action: 'stage', name: '宫宴角色', meta: '影游互动 · 影游宫宴', image: '/showroom/avatars/gaming.jpg', outfit: '样板间·宫宴角色', voice: 'female_gentle_c' },
  { industry: 'gaming', scene: 'palace', persona: 'npc_qing_dai', script: 'npc_scene', action: 'stage', name: '古风侍女', meta: '影游互动 · 宫宴侍女', image: '/showroom/avatars/qing.jpg', outfit: '样板间·古风侍女', voice: 'female_tender_e' },
  { industry: 'music', scene: 'stage', persona: 'velvety_night', script: 'music_5', action: 'natural', name: '磁性电台', meta: '音乐电台 · 音乐舞台', image: '/showroom/avatars/music.jpg', outfit: '样板间·磁性电台', voice: 'male_velvety_f' },
  { industry: 'music', scene: 'stage', persona: 'cool_queen', script: 'music_5', action: 'natural', name: '高冷御姐', meta: '音乐电台 · 冷感舞台', image: '/showroom/avatars/cool.jpg', outfit: '样板间·高冷御姐', voice: 'female_clear_a' },
];

const OPENINGS = {
  '温柔陪伴': [
    '来了呀，先坐，慢慢聊。今天不赶流程，先说说你今天过得怎么样，有没有哪一刻特别想找个人说说话？',
    '晚上好，我是今晚陪你聊天的人。先把声音放轻一点，我们从一个很小的问题开始：今天有没有什么小事，让你偷偷开心了一下？',
    '别急着走，今晚时间还长。先告诉我你现在是一个人，还是刚下班，我可以根据你的状态，把话题放慢一点。',
  ],
  '甜美元气': [
    '哈喽哈喽，终于等到你啦！今天先不聊大道理，我想听你说一件最近让你嘴角上扬的小事，看看我们谁先笑出声。',
    '哇，你来啦！先给你一个元气满满的问候：今天有没有好好吃饭？没有的话，我可要念叨你两句了。',
    '今天的状态超适合聊点轻松的，我先开个头：如果现在可以立刻去一个地方，你会选海边、山里，还是回家躺平？',
  ],
  '搞笑俏皮': [
    '来了来了，今天这场主打一个不正经但很真诚。先问你个问题：如果老板和闹钟同时掉水里，你先救哪个？',
    '欢迎来到今天的快乐现场，我先自曝一个糗事，你听完要是没笑，我接下来就表演一个更离谱的。',
    '别光看，弹幕给我出个难题。今天咱们不按剧本走，你说一个场景，我现场给你接一个反套路。',
  ],
  '知性讲师': [
    '欢迎来到今天的分享。我们先不急着下结论，先看一个常见误区：很多人以为记住结论就够了，其实真正关键的是它怎么来的。',
    '今天我准备从一个具体问题讲起，大概分三步：先拆概念，再看案例，最后给你一个能直接用的方法。',
    '如果你只有五分钟，先记住这一句话：先把问题定义清楚，答案就已经出现一半。接下来我用一个生活里的例子，把这句话讲透。',
  ],
  '活力带货': [
    '家人们，今天这场我只讲三件事：为什么值得买、适合谁、怎么买最划算。先看第一个，别急着划走。',
    '欢迎来到直播间，今天不绕弯子，先把手里的产品讲清楚，再回答你们最关心的价格和售后。',
    '先别下单，听我把这个细节讲完。这个东西不是所有人都适合，我只推荐给真正用得上的人，你再决定。',
  ],
  '生活主理人': [
    '今天不聊远的，就聊一顿饭。先把锅坐上，我们边做边聊：你最近最常做的一道菜是什么？',
    '欢迎来家里坐坐。今天想跟你分享一个特别省事的生活小办法，学会之后能少操不少心。',
    '日子嘛，就是这些小东西撑起来的。今天我从厨房开始，跟你聊聊怎么把普通的一天过得舒服一点。',
  ],
  '宫宴角色': [
    '本宫今日心情尚可，便许你在此多留片刻。说说吧，你从何处来，又为何事而来？',
    '既入了这宫宴，便不必拘礼。先饮一盏，再慢慢说——你想要的，是荣宠，还是一句真话？',
    '这殿中人多眼杂，你我只说三分。你若信得过本宫，便把刚才那句话，再讲一遍。',
  ],
  '古风侍女': [
    '小主先坐，奴婢给您沏盏茶。今日风大，您从外头来，先暖暖手再说话。',
    '您今日来得正好，园子里的花刚开。奴婢不敢多嘴，只想问问，您心里那件事，可有了主意？',
    '奴婢听着呢，您慢慢说。若是拿不定主意，奴婢陪您把前因后果捋一遍，再决定也不迟。',
  ],
  '磁性电台': [
    '夜深了，把灯关小一点。今天不讲大道理，先听一段声音，再慢慢告诉你一个关于夜晚的故事。',
    '欢迎收听今晚的节目。先别急着说话，给自己一分钟，把今天的情绪放下来，我们从头开始。',
    '如果你也还没睡，说明我们大概在同一座城市里醒着。今晚想聊一个很轻的话题：你最近单曲循环的是哪一首？',
  ],
  '高冷御姐': [
    '来了就坐，别拘谨。我说话直，你也不用绕。今天想聊什么，先把最重要的一句说清楚。',
    '我不太喜欢寒暄，直接进入正题。你现在的状态，是来听建议，还是只想找个人把话说完？',
    '先别急着解释。你想让别人理解你，还是想让自己想明白？这两个答案，会决定我们接下来怎么聊。',
  ],
};

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
  const choices = OPENINGS[person.name] || [];
  $('showroomOpening').value = choices.length ? choices[Math.floor(Math.random() * choices.length)] : (currentScript()?.opening || '');
  setParams(industry?.params || {});
  renderIndustries();
  renderScenes();
  status(`已选人物：${person.name} · ${person.meta}`);
  return apply(startAfter, person.outfit, person.voice);
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
  $('showroomSilence').value = Number(triggers.silence_s ?? 10);
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

async function apply(startAfter = false, preferredOutfit = '', preferredVoice = '') {
  if (!catalog) return false;
  let applied = false;
  const payload = {
    industry_id: selectedIndustry,
    scene_id: selectedScene,
    persona_id: $('showroomPersona').value,
    voice_id: preferredVoice || undefined,
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
    const outfit = outfits.find(item => item.name === (preferredOutfit || scene?.outfit_name));
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

const showroomTopNav = document.getElementById('showroomTopNav');
if (showroomTopNav) {
  showroomTopNav.addEventListener('click', event => {
    event.preventDefault();
    const drawer = document.getElementById('consoleDrawer');
    if (drawer?.hidden) document.getElementById('consoleButton')?.click();
    setTimeout(() => document.getElementById('csShowroom')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
  });
}
