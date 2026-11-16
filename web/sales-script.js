/**
 * 带货分段脚本：30s 开场 → 3min 单品 → 1min 答疑 → 真实机制
 * - 逐句调用 /api/voice/preview 生成 TTS，再走 S2Bridge.speakOut 播出
 * - 每段绑定动作组；动作先于 PCM 发送
 * - 价格/库存/结束时间必须由运营填写，不在代码里编造
 */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const SEGMENTS = [
  {
    id: 'opening',
    label: '30 秒开场',
    duration: 30,
    intent: '先别急着拍：说清今天只讲一个品，给观众留下来的理由',
    actions: ['面向镜头微笑', '轻轻点头'],
    lines: [
      { text: '刚进来的朋友先别急着拍。我是今天的主播，今天只讲一个品：{{product}}。给我三十秒，我把适合谁、不适合谁讲清楚，你再决定。', actions: ['面向镜头微笑'], pause_after_ms: 800 },
      { text: '如果你正好需要{{benefit}}，先留下来听；如果只是随便看看，也没关系。今天不喊最后一天，只讲真实机制。', actions: ['轻轻点头'], pause_after_ms: 800 },
    ],
  },
  {
    id: 'product',
    label: '3 分钟单品',
    duration: 180,
    intent: '一个卖点 + 场景 + 演示 + 对比 + 适合/不适合，不堆参数',
    actions: ['凑近屏幕点头，回位坐正', '身体前倾点头，回正微笑', '看一眼弹幕，微笑转回镜头'],
    lines: [
      { text: '先说适合谁：{{audience}}。如果你不是这类人，先别拍，听了也白听。', actions: ['面向镜头微笑'], pause_after_ms: 1200 },
      { text: '今天不讲十个卖点，只讲一个：{{benefit}}。为什么？因为参数再多，你用得上的通常就一个。', actions: ['轻轻点头'], pause_after_ms: 1200 },
      { text: '看这个场景：{{scene}}。你是不是也遇到过？这不是你的问题，是工具没选对。', actions: ['凑近屏幕点头，回位坐正'], pause_after_ms: 1200 },
      { text: '我现场给你看：{{detail}}。我不说最好，你看这个细节，适不适合你，自己判断。', actions: ['身体前倾点头，回正微笑'], pause_after_ms: 1200 },
      { text: '再做个对比：{{compare}}。左边是普通做法，右边是它，差别在这儿。', actions: ['看一眼弹幕，微笑转回镜头'], pause_after_ms: 1200 },
      { text: '它不完美：{{limitation}}。我把缺点先说了，能接受再买，接受不了就别拍。', actions: ['轻轻点头'], pause_after_ms: 1200 },
      { text: '适合谁：{{audience}}。不适合谁：{{notFor}}。我只卖适合的人，不适合的我不推。', actions: ['凑近屏幕点头，回位坐正'], pause_after_ms: 1200 },
      { text: '怎么用最省：{{usage}}。不用囤，按需买，先用完再复购。', actions: ['面向镜头微笑'], pause_after_ms: 1200 },
      { text: '价格我不喊最低，只讲真实：{{originalText}}今天直播价 {{price}}。你觉得值再拍。', actions: ['轻轻点头'], pause_after_ms: 1200 },
      { text: '库存和时效我也说清楚：库存 {{stock}}，机制到 {{end}} 结束。没了就是没了，我不演戏。', actions: ['身体前倾点头，回正微笑'], pause_after_ms: 1200 },
      { text: '如果你还在犹豫，先问自己一个问题：{{question}}。答案是“需要”，再拍；答案是“便宜”，先别拍。', actions: ['头部微倾倾听'], pause_after_ms: 1200 },
      { text: '总结一句：{{product}}适合{{audience}}，核心价值是{{benefit}}。需要的听机制，不需要的可以划走。', actions: ['面向镜头微笑'], pause_after_ms: 1200 },
    ],
  },
  {
    id: 'qa',
    label: '1 分钟答疑',
    duration: 60,
    intent: '接住弹幕问题，先回答适合/不适合，再给使用建议',
    actions: ['凑近镜头看弹幕，捂嘴笑回位', '头部微倾倾听', '轻轻点头'],
    lines: [
      { text: '先回答弹幕里问得最多的两个问题。第一个：适合谁？{{audience}}。第二个：不适合谁？{{notFor}}。', actions: ['凑近镜头看弹幕，捂嘴笑回位'], pause_after_ms: 900 },
      { text: '怎么用：{{usage}}。还有问题直接打公屏，我看到就回，不急着拍。', actions: ['头部微倾倾听'], pause_after_ms: 900 },
      { text: '不适合的我会直接说，别为了便宜买错。对号入座，别冲动。', actions: ['轻轻点头'], pause_after_ms: 900 },
    ],
  },
  {
    id: 'mechanism',
    label: '真实机制',
    duration: 60,
    intent: '只讲真实价格、真实库存、真实结束时间，给不买的人体面',
    actions: ['面向镜头微笑', '轻轻点头'],
    lines: [
      { text: '最后说真实机制：{{product}}，{{originalText}}今天直播价 {{price}}；库存 {{stock}}；机制到 {{end}} 结束。', actions: ['面向镜头微笑'], pause_after_ms: 1000 },
      { text: '我不催你，先算账：本来就要买，今天确实省；只是觉得便宜，先别拍。', actions: ['轻轻点头'], pause_after_ms: 1000 },
      { text: '需要的现在拍，不需要就听我讲完；买错比买贵更亏。', actions: ['面向镜头微笑'], pause_after_ms: 1000 },
      { text: '拍了的回个“已拍”，我让场控核对；没拍的也不用有压力，下次还有机会。', actions: ['轻轻点头'], pause_after_ms: 0 },
    ],
  },
];

const state = {
  running: false,
  paused: false,
  stopped: false,
  skip: false,
  segIndex: 0,
  lineIndex: 0,
  controller: null,
  timer: null,
  startedAt: 0,
};

function valueOf(key) {
  const product = $('salesProduct').value.trim() || '这个品';
  const price = $('salesPrice').value.trim() || '以直播间实际为准';
  const original = $('salesOriginal').value.trim();
  const stock = $('salesStock').value.trim() || '以直播间实际为准';
  const end = $('salesEnd').value.trim() || '以直播间实际为准';
  const map = {
    product,
    price,
    stock,
    end,
    originalText: original ? `日常价 ${original}，` : '',
    audience: '正好需要它、并且愿意按说明使用的人',
    benefit: '用起来更省心，而不是买回去增加负担',
    pain: '反复试错、买回去不合适',
    scene: '每天早上赶时间，或者下班后只想快点搞定',
    detail: '材质、做工和使用步骤，我都放在镜头前给你看',
    compare: '同样的用法，一个更费时间，一个更省步骤',
    limitation: '它不适合追求极致低价，也不适合买来囤着',
    notFor: '只需要最便宜替代品、或者根本用不上的人',
    usage: '按说明用量，先用完再复购，不要一次囤太多',
    question: '如果今天不买，你还会不会专门去买？',
  };
  return map[key] ?? '';
}

function fill(text) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => valueOf(key));
}

function hasRealMechanism() {
  return Boolean($('salesProduct').value.trim() && $('salesPrice').value.trim() && $('salesStock').value.trim() && $('salesEnd').value.trim());
}

function renderSegments() {
  const host = $('salesSegments');
  if (!host) return;
  host.replaceChildren();
  SEGMENTS.forEach(segment => {
    const card = document.createElement('div');
    card.className = `sales-segment${state.running && SEGMENTS[state.segIndex]?.id === segment.id ? ' active' : ''}`;
    const header = document.createElement('header');
    const title = document.createElement('b'); title.textContent = segment.label;
    const time = document.createElement('span'); time.textContent = `${segment.duration}s`;
    header.append(title, time);
    const intent = document.createElement('small'); intent.textContent = segment.intent;
    const actions = document.createElement('div'); actions.className = 'sales-actions';
    segment.actions.forEach(name => {
      const chip = document.createElement('span'); chip.textContent = name; actions.appendChild(chip);
    });
    card.append(header, intent, actions);
    host.appendChild(card);
  });
}

function setStatus(text, isError = false) {
  const status = $('salesStatus');
  status.hidden = !text;
  status.textContent = text || '';
  status.classList.toggle('error-text', isError);
}

function setRunning(running) {
  state.running = running;
  window.SALES_SCRIPT_RUNNING = running;
  $('salesStart').disabled = running;
  $('salesPause').disabled = !running;
  $('salesNext').disabled = !running;
  $('salesStop').disabled = !running;
  $('salesProgress').hidden = !running;
  if (!running) {
    state.paused = false;
    $('salesPause').textContent = '暂停';
    clearInterval(state.timer);
    state.timer = null;
    renderSegments();
  }
}

function setProgressFor(segIndex, lineIndex) {
  const total = SEGMENTS.reduce((sum, segment) => sum + segment.duration, 0);
  const before = SEGMENTS.slice(0, segIndex).reduce((sum, segment) => sum + segment.duration, 0);
  const segment = SEGMENTS[segIndex];
  const within = segment ? (Math.max(0, lineIndex + 1) / segment.lines.length) * segment.duration : 0;
  $('salesProgress').value = Math.min(100, ((before + within) / total) * 100);
}

function startProgress() {
  clearInterval(state.timer);
  state.timer = null;
  state.startedAt = Date.now();
  $('salesProgress').hidden = false;
  $('salesProgress').value = 0;
}

async function waitWhilePaused() {
  while (state.paused && !state.stopped) await sleep(200);
}

async function speakLine(text) {
  const bridge = window.S2Bridge;
  const response = await fetch('/api/voice/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: state.controller?.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `TTS HTTP ${response.status}`);
  if (!data.audio) throw new Error('TTS 未返回音频');
  await bridge.speakOut(data.text || text, data.audio, data.text || text);
}

async function runScript() {
  const bridge = window.S2Bridge;
  if (!hasRealMechanism()) {
    setRunning(false);
    setStatus('真实机制四项必填：商品名、直播价、库存、结束时间', true);
    return;
  }
  if (!bridge?.isRunning?.() || !bridge?.isReady?.()) {
    setRunning(false);
    setStatus('请先开始直播并等待画面就绪', true);
    return;
  }

  state.stopped = false;
  state.paused = false;
  state.skip = false;
  state.segIndex = 0;
  state.lineIndex = 0;
  state.controller = new AbortController();
  setRunning(true);
  startProgress();
  bridge.log?.('带货脚本开始：30s 开场 → 3min 单品 → 1min 答疑 → 真实机制');

  try {
    for (let segIndex = 0; segIndex < SEGMENTS.length; segIndex += 1) {
      if (state.stopped) break;
      state.segIndex = segIndex;
      state.skip = false;
      const segment = SEGMENTS[segIndex];
      renderSegments();
      bridge.log?.(`带货脚本 · ${segment.label}（动作组：${segment.actions.join(' / ')}）`);
      for (let lineIndex = 0; lineIndex < segment.lines.length; lineIndex += 1) {
        if (state.stopped) break;
        if (state.skip) break;
        await waitWhilePaused();
        if (state.stopped) break;
        state.lineIndex = lineIndex;
        const line = segment.lines[lineIndex];
        const text = fill(line.text);
        setProgressFor(segIndex, lineIndex);
        setStatus(`${segment.label} · 第 ${lineIndex + 1}/${segment.lines.length} 句 · 动作：${(line.actions || segment.actions).join(' / ')}`);
        for (const action of (line.actions || segment.actions).slice(0, 2)) {
          if (bridge.sendAction(action)) bridge.log?.(`带货脚本 · 动作：${action}`);
        }
        await speakLine(text);
        if (line.pause_after_ms) await sleep(line.pause_after_ms);
      }
      if (state.skip && !state.stopped) {
        state.skip = false;
        bridge.log?.(`带货脚本 · 跳过剩余部分，进入下一段`);
      }
    }
    if (!state.stopped) {
      $('salesProgress').value = 100;
      setStatus('整段结束：30s 开场 / 3min 单品 / 1min 答疑 / 真实机制');
      bridge.log?.('带货脚本完成');
    }
  } catch (error) {
    if (!state.stopped) {
      setStatus(`脚本中断：${error.message}`, true);
      bridge.log?.(`带货脚本中断：${error.message}`);
    }
  } finally {
    setRunning(false);
    state.controller = null;
  }
}

function stopScript(reason = '手动结束') {
  state.stopped = true;
  state.paused = false;
  state.skip = false;
  state.controller?.abort();
  window.S2Bridge?.interrupt?.();
  setRunning(false);
  setStatus(`已结束：${reason}`);
  window.S2Bridge?.log?.(`带货脚本结束：${reason}`);
}

function bind() {
  if (!$('salesStart')) return;
  renderSegments();
  $('salesStart').onclick = () => { runScript().catch(error => setStatus(`启动失败：${error.message}`, true)); };
  $('salesPause').onclick = () => {
    if (!state.running) return;
    state.paused = !state.paused;
    $('salesPause').textContent = state.paused ? '继续' : '暂停';
    setStatus(state.paused ? '已暂停；当前句播完后停住' : '继续播放');
  };
  $('salesNext').onclick = () => {
    if (!state.running) return;
    state.skip = true;
    state.paused = false;
    $('salesPause').textContent = '暂停';
    window.S2Bridge?.interrupt?.();
    setStatus('跳过当前句，进入下一段');
  };
  $('salesStop').onclick = () => stopScript();
}

bind();
