/**
 * S2 自然度参数面板的“资产形象 / 转场播放”补充：
 * - 注册当前形象为 avatar_id（type=16 必须用资产 ID）
 * - 按 s2 参数：baseline_reset → hold_ms → switch_videos + avatar_id
 * 参数表单本身由 console.js 的 loadS2/saveS2 管理。
 */
const $ = id => document.getElementById(id);
const STORE_AVATAR = 's2_transition_avatar';

function setStatus(text, error = false) {
  const node = $('s2PlayStatus');
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
  node.classList.toggle('error-text', error);
}

function videos() {
  return String($('s2Videos')?.value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function register() {
  const bridge = window.S2Bridge;
  if (!bridge?.avatarImage) { setStatus('当前页面不支持形象读取', true); return; }
  const image = await bridge.avatarImage();
  if (!image) { setStatus('先在左侧选择出镜形象，再注册 avatar_id', true); return; }
  setStatus('正在注册资产形象…');
  try {
    const response = await fetch('/api/avatars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_uri: image, name: 's2-transition-avatar' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    $('s2AvatarId').value = data.avatar_id;
    localStorage.setItem(STORE_AVATAR, data.avatar_id);
    setStatus(`已注册 avatar_id=${data.avatar_id}`);
    window.S2Bridge?.log?.(`转场 · 资产形象已注册：${data.avatar_id}`);
  } catch (error) {
    setStatus(`注册失败：${error.message}`, true);
  }
}

async function play() {
  const bridge = window.S2Bridge;
  const avatarId = $('s2AvatarId').value.trim() || localStorage.getItem(STORE_AVATAR) || '';
  const list = videos();
  if (!bridge?.liveActive?.()) { setStatus('先开播，再播放转场', true); return; }
  if (!avatarId) { setStatus('缺少 avatar_id：可点“注册当前形象”', true); return; }
  if (!list.length || list.length > 10) { setStatus('转场视频须为 1–10 个 http(s) URL', true); return; }
  if (list.some(url => !/^https?:\/\//i.test(url))) { setStatus('转场视频必须是公网 http(s) URL', true); return; }
  localStorage.setItem(STORE_AVATAR, avatarId);
  const baseline = $('s2Baseline')?.checked !== false;
  const hold = Math.max(0, Number($('s2Hold')?.value) || 0);
  if (baseline) {
    bridge.baselineReset?.();
    setStatus(`type=15 已发；${hold}ms 后播放 ${list.length} 段转场…`);
    await new Promise(resolve => setTimeout(resolve, hold));
  }
  const ok = bridge.switchAvatar(list, avatarId);
  setStatus(ok ? `type=16 已发出：${list.length} 段转场 → avatar ${avatarId}` : 'type=16 发送失败：WS 未就绪或参数不合法', !ok);
  if (ok) window.S2Bridge?.log?.('转场 · switch_avatar 已发送');
}

function reset() {
  if (!window.S2Bridge?.liveActive?.()) { setStatus('先开播，再复位', true); return; }
  const ok = window.S2Bridge.baselineReset?.();
  setStatus(ok ? 'type=15 已发出：复位到闭口静息态' : 'type=15 发送失败', !ok);
}

function bind() {
  if (!$('s2PlayTransition')) return;
  $('s2AvatarId').value = localStorage.getItem(STORE_AVATAR) || '';
  $('s2Register').onclick = () => register();
  $('s2PlayTransition').onclick = () => play();
  $('s2Reset').onclick = () => reset();
  $('s2AvatarId').addEventListener('change', () => localStorage.setItem(STORE_AVATAR, $('s2AvatarId').value.trim()));
  window.addEventListener('s2-command-result', event => {
    const result = event.detail || {};
    if (!result.source || result.source === 'switch_avatar') {
      const state = result.status || (result.success === false ? 'failed' : 'finished');
      setStatus(`switch_avatar ${state}${result.error_code ? ` · ${result.error_code}` : ''}`, result.success === false);
    }
  });
}

bind();
