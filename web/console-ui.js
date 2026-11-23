/**
 * 中控台折叠层：把 drawer-section 收成带图标 / 类型标签的抽屉。
 * 默认只显示“常用”，其余按分类筛选；展开后完整文字和控件都在。
 */
const SECTION_META = [
  { test: /样板间/, icon: '◈', chips: ['行业', '场景', '人物', '动作'], cat: '基础', common: true },
  { test: /人设/, icon: '◉', chips: ['人设', '音色', '开场白'], cat: '基础', common: true },
  { test: /主动唤醒/, icon: '◷', chips: ['沉默', '小动作', '冷启动'], cat: '基础' },
  { test: /礼物档位/, icon: '◇', chips: ['低档', '中档', '高档'], cat: '基础' },
  { test: /意图矩阵/, icon: '⌘', chips: ['规则', '优先级'], cat: '基础' },
  { test: /互动玩法/, icon: '▣', chips: ['小游戏', '礼物特效'], cat: '互动', common: true },
  { test: /S2 自然度/, icon: '⚙', chips: ['分辨率', '转场', '唱跳', 'idle'], cat: '自然度', common: true },
  { test: /现场生成/, icon: '✦', chips: ['唱歌', 'MV', '图生视频'], cat: '生成', common: true },
  { test: /拉丁舞/, icon: '◐', chips: ['实时序列', 'Motion Sync'], cat: '自然度' },
  { test: /带货脚本/, icon: '▤', chips: ['30s', '3min', '1min', '机制'], cat: '自然度', common: true },
  { test: /已生成视频/, icon: '▶', chips: ['上传', '公开链接'], cat: '生成' },
  { test: /事件模拟/, icon: '✉', chips: ['弹幕', '礼物', 'PK'], cat: '互动' },
  { test: /调度时间线/, icon: '⌁', chips: ['运行日志'], cat: '调试' },
];

function metaOf(title) {
  return SECTION_META.find(item => item.test.test(title)) || { icon: '·', chips: [], cat: '基础' };
}

function summaryText(section) {
  const node = section.querySelector('.help, p');
  const text = (node?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return '展开查看完整设置';
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

function upgradeSection(section, index) {
  const heading = section.querySelector('h3');
  if (!heading) return null;
  const title = heading.textContent.trim();
  const meta = metaOf(title);
  const details = document.createElement('details');
  details.className = 'console-accordion';
  details.dataset.cat = meta.cat;
  details.dataset.common = meta.common ? '1' : '0';
  if (heading.id) details.setAttribute('aria-labelledby', heading.id);

  const summary = document.createElement('summary');
  summary.title = '点击展开；点右侧箭头收起';
  const icon = document.createElement('span');
  icon.className = 'ca-icon';
  icon.textContent = meta.icon;
  icon.setAttribute('aria-hidden', 'true');

  const main = document.createElement('span');
  main.className = 'ca-main';
  const headRow = document.createElement('span');
  headRow.className = 'ca-head-row';
  heading.classList.add('ca-heading');
  headRow.appendChild(heading);

  const desc = document.createElement('span');
  desc.className = 'ca-desc';
  desc.textContent = summaryText(section);
  main.append(headRow, desc);

  const chips = document.createElement('span');
  chips.className = 'ca-chips';
  for (const label of meta.chips) {
    const chip = document.createElement('span');
    chip.className = 'ca-chip';
    chip.textContent = label;
    chips.appendChild(chip);
  }
  if (chips.childElementCount) main.appendChild(chips);

  const arrow = document.createElement('span');
  arrow.className = 'ca-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '›';
  arrow.title = '展开 / 收起';
  summary.append(icon, main, arrow);

  // 点标题只展开，不收起；要收起点右侧箭头。
  // 这样点“人设”不会把已展开的面板又变回一条横线。
  summary.addEventListener('click', event => {
    event.preventDefault();
    if (event.target.closest('.ca-arrow')) {
      details.open = !details.open;
    } else {
      details.open = true;
    }
  });

  const body = document.createElement('div');
  body.className = 'ca-body';
  while (section.firstChild) {
    const child = section.firstChild;
    section.removeChild(child);
    if (child !== heading) body.appendChild(child);
  }
  details.append(summary, body);
  section.replaceWith(details);
  return details;
}

function renderTabs(details) {
  const host = document.getElementById('consoleTabs');
  if (!host) return;
  const categories = ['常用', '全部', '基础', '自然度', '互动', '生成', '调试'];
  let active = '常用';
  const apply = category => {
    active = category;
    for (const item of details) {
      item.hidden = category === '常用'
        ? item.dataset.common !== '1'
        : category !== '全部' && item.dataset.cat !== category;
    }
    host.querySelectorAll('.console-tab').forEach(button => button.classList.toggle('active', button.dataset.cat === category));
  };
  host.replaceChildren();
  for (const category of categories) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'console-tab';
    button.dataset.cat = category;
    const count = category === '常用'
      ? details.filter(item => item.dataset.common === '1').length
      : category === '全部' ? details.length : details.filter(item => item.dataset.cat === category).length;
    button.textContent = `${category} ${count}`;
    button.onclick = () => apply(category);
    host.appendChild(button);
  }
  apply(active);
}

function upgrade() {
  const body = document.getElementById('consoleBody');
  if (!body || body.dataset.accordionReady === '1') return;
  const sections = [...body.querySelectorAll(':scope > section.drawer-section')];
  const details = sections.map(upgradeSection).filter(Boolean);
  body.dataset.accordionReady = '1';
  renderTabs(details);
  document.getElementById('consoleExpandAll')?.addEventListener('click', () => {
    details.filter(item => !item.hidden).forEach(item => { item.open = true; });
  });
  document.getElementById('consoleCollapseAll')?.addEventListener('click', () => {
    details.forEach(item => { item.open = false; });
  });
}

upgrade();
