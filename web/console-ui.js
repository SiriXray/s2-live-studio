/**
 * 中控台折叠层：把每个 drawer-section 收成“标题 + 一句摘要”的抽屉。
 * 只做 DOM 包装，不改任何控件 ID / 事件绑定；展开后原文完整显示。
 */
const CATEGORY_RULES = [
  { name: '自然度', test: /S2 自然度|拉丁舞|带货脚本/ },
  { name: '互动', test: /互动玩法|事件模拟/ },
  { name: '生成', test: /现场生成|已生成视频/ },
  { name: '调试', test: /调度时间线/ },
  { name: '基础', test: /样板间|人设|主动唤醒|礼物档位|意图矩阵/ },
];

function categoryOf(title) {
  return CATEGORY_RULES.find(rule => rule.test.test(title))?.name || '基础';
}

function summaryText(section) {
  const node = section.querySelector('.help, p');
  const text = (node?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return '点击展开完整设置';
  return text.length > 52 ? `${text.slice(0, 52)}…` : text;
}

function upgradeSection(section, index) {
  const heading = section.querySelector('h3');
  if (!heading) return null;
  const title = heading.textContent.trim();
  const desc = summaryText(section);
  const details = document.createElement('details');
  details.className = 'console-accordion';
  details.dataset.cat = categoryOf(title);
  details.dataset.index = String(index);
  if (heading.id) details.setAttribute('aria-labelledby', heading.id);

  const summary = document.createElement('summary');
  heading.classList.add('ca-heading');
  const arrow = document.createElement('span');
  arrow.className = 'ca-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '›';
  const descNode = document.createElement('span');
  descNode.className = 'ca-desc';
  descNode.textContent = desc;
  summary.append(heading, descNode, arrow);

  const body = document.createElement('div');
  body.className = 'ca-body';
  while (section.firstChild) {
    const child = section.firstChild;
    section.removeChild(child);
    if (child !== heading) body.append(child);
  }
  details.append(summary, body);
  section.replaceWith(details);
  return details;
}

function renderTabs(details) {
  const host = document.getElementById('consoleTabs');
  if (!host) return;
  const categories = ['全部', '基础', '自然度', '互动', '生成', '调试'];
  host.replaceChildren();
  for (const category of categories) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `console-tab${category === '全部' ? ' active' : ''}`;
    button.dataset.cat = category;
    const count = category === '全部' ? details.length : details.filter(item => item.dataset.cat === category).length;
    button.textContent = `${category} ${count}`;
    button.onclick = () => {
      host.querySelectorAll('.console-tab').forEach(item => item.classList.toggle('active', item === button));
      for (const item of details) item.hidden = category !== '全部' && item.dataset.cat !== category;
    };
    host.appendChild(button);
  }
}

function upgrade() {
  const body = document.getElementById('consoleBody');
  if (!body || body.dataset.accordionReady === '1') return;
  const sections = [...body.querySelectorAll(':scope > section.drawer-section')];
  const details = [];
  sections.forEach((section, index) => {
    const item = upgradeSection(section, index);
    if (item) details.push(item);
  });
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
