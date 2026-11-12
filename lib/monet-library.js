'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getManifest } = require('./monet');

const ACTION_STYLE = '莫奈是自然亲切的创意伙伴。固定镜头，保持输入人物的脸、发型、服装和身体比例。倾听时轻微呼吸、自然眨眼，回应时按语义配合克制的微笑或轻手势，不每句话都摆动作。动作平滑起势、短暂保持、缓慢收回，不循环抽动。不主动亲吻、不夸张扭动、不凭空出现道具。半身图不跨步、不转圈、不做全身舞蹈。';

function createMonetLibrary(options) {
  const manifest = getManifest();
  const actions = [...manifest.actions, ...Object.values(manifest.cues)];
  const revision = crypto.createHash('sha256').update(JSON.stringify(actions)).digest('hex').slice(0, 10);
  const name = `Monet自然交互-${revision}`;
  const fingerprint = config => crypto.createHash('sha256').update(`${config.vidu.host}:${config.vidu.api_key}`).digest('hex');
  let progress = { busy: false, completed: 0, total: actions.length };
  function status(config) {
    const saved = fs.existsSync(options.file) ? JSON.parse(fs.readFileSync(options.file, 'utf8')) : {};
    const matching = saved.fingerprint === fingerprint(config) && saved.revision === revision;
    return { ...progress, name, ready: Boolean(matching && saved.ready), library_id: matching ? saved.library_id || '' : '' };
  }
  function save(config, value) {
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
    fs.writeFileSync(`${options.file}.tmp`, JSON.stringify({ ...value, revision, fingerprint: fingerprint(config) }), { mode: 0o600 });
    fs.renameSync(`${options.file}.tmp`, options.file);
  }
  async function request(config, method, resource, body) {
    const key = config.vidu.api_key;
    const response = await (options.transport || fetch)(`https://${config.vidu.host}/live/v1${resource}`, {
      method,
      headers: { Authorization: /^(Token|Bearer)\s/i.test(key) ? key : `Token ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(90000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`动作库接口HTTP ${response.status}；请检查权限、配额或控制台状态，不自动重试写入`);
    return response.json();
  }
  async function findLibrary(config) {
    for (let page = 0; page < 3; page++) {
      const result = await request(config, 'GET', `/action-libraries?pager.page=${page}&pager.pagesz=10`);
      if (!Array.isArray(result.items)) throw new Error('动作库列表响应不符合文档');
      const found = result.items.find(item => item.name === name);
      if (found) return found;
      if (result.items.length < 10 || (page + 1) * 10 >= result.total) return null;
    }
    throw new Error('动作库列表超出当前账号文档配额范围，请在控制台检查');
  }
  async function prepare(config) {
    if (progress.busy) throw new Error('动作库正在准备，请勿重复点击');
    if (!config.vidu.api_key) throw new Error('请先配置Vidu API Key');
    progress = { busy: true, completed: 0, total: actions.length };
    try {
      let library = await findLibrary(config);
      if (!library) {
        await request(config, 'POST', '/action-libraries', { name, description: 'Monet自然交互：50个表情动作及欢迎、告别；固定镜头，动作起势与归位，非循环强制表演。' });
        library = await findLibrary(config);
      }
      if (!library || typeof library.id !== 'string' || !/^\d+$/.test(library.id)) throw new Error('未确认动作库ID；请核查控制台后再次准备，不自动重建');
      const saved = status(config);
      if (saved.ready && saved.library_id === library.id) return { ...saved, busy: false };
      save(config, { library_id: library.id, ready: false });
      const listed = await request(config, 'GET', `/action-libraries/${library.id}/actions`);
      const existing = Array.isArray(listed) ? listed : listed.items;
      if (!Array.isArray(existing) || (listed.total && listed.total > existing.length)) throw new Error('动作列表不完整；请核查平台分页协议后继续，避免重复创建');
      for (const action of actions) {
        if (!existing.some(item => item.name === action.name)) await request(config, 'POST', `/action-libraries/${library.id}/actions`, { name: action.name, description: action.description });
        progress.completed++;
      }
      save(config, { library_id: library.id, ready: true });
      return { ...status(config), busy: false };
    } finally { progress.busy = false; }
  }
  return { status, prepare };
}

module.exports = { createMonetLibrary, ACTION_STYLE };
