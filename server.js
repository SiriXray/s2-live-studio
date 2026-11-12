'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createConfigStore } = require('./lib/config');
const { signToken } = require('./lib/tokens');
const { reply, synthesizeWithFallback, validateTurn } = require('./lib/ai');
const appearance = require('./lib/appearance');
const { imageData, imageUri } = require('./lib/images');
const { getManifest, planTurn } = require('./lib/monet');
const { prepareMonet, validateMonetProfile } = require('./lib/monet-dialogue');
const { createMonetLibrary, ACTION_STYLE } = require('./lib/monet-library');
const { createInteraction } = require('./lib/interaction');
const { createNpcGame } = require('./lib/npcgame');
const { getPersona, styleInstruction } = require('./lib/personas');
const { voiceForPersona, patchForVoice, getVoice, listVoices } = require('./lib/voices');
const { detectAvatar, matchVoiceFromAnalysis } = require('./lib/vlm');
const { createEffects, GIFT_FX, mapGiftFx } = require('./lib/effects');
const { createMvStudio } = require('./lib/mv');
const { cloneVoice } = require('./lib/clone');

const execFileAsync = promisify(execFile);

/**
 * 视频 → 提取音轨作为歌曲（≤300 秒，AAC/m4a）。
 * 服务端需 ffmpeg/ffprobe（ECS 已装静态版）；超过 300 秒自动截断。
 * 输入可以是本地上传文件路径或公网 http(s) URL。
 */
async function musicFromVideoFile(input) {
  let duration = 0;
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { timeout: 60000 });
    duration = Number(JSON.parse(stdout).format?.duration) || 0;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('服务端未安装 ffmpeg，无法从视频提取音轨；请改用音乐库曲目');
    throw new Error(`视频解析失败：${error.message.slice(0, 120)}`);
  }
  if (duration < 10) throw new Error(`视频音轨时长须 ≥10 秒（当前 ${duration ? duration.toFixed(1) : '未知'}s）`);
  const output = `${input}.m4a`;
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-acodec', 'aac', '-b:a', '160k', '-t', '300', '-movflags', '+faststart', output], { timeout: 300000 });
  const buffer = fs.readFileSync(output);
  if (buffer.length > 20 * 1024 * 1024) throw new Error('提取的音轨超过 20MB 上限');
  return { name: 'mv_audio.m4a', buffer, duration_s: Math.min(Math.round(duration), 300) };
}

async function musicFromVideoUrl(url) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('MV 视频链接须为公网 http(s) URL');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 's2mv-'));
  try {
    const input = path.join(work, 'input.bin');
    const res = await fetch(url, { signal: AbortSignal.timeout(300000), redirect: 'follow' });
    if (!res.ok) throw new Error(`MV 视频下载失败 HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 200 * 1024 * 1024) { reader.cancel().catch(() => {}); throw new Error('MV 视频超过 200MB 上限'); }
      chunks.push(Buffer.from(value));
    }
    fs.writeFileSync(input, Buffer.concat(chunks));
    return await musicFromVideoFile(input);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readJson(request, limit = 12 * 1024 * 1024) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('需要application/json请求'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw Object.assign(new Error('JSON格式不正确'), { status: 400 }); }
}

/** 解析 multipart/form-data（单层，不嵌套；返回 [{name, filename?, data:Buffer}]） */
async function readMultipart(request, boundary, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const parts = [];
  const sections = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(boundary, cursor);
    if (start === -1) break;
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    sections.push(body.subarray(start + boundary.length, next));
    cursor = next;
  }
  for (const section of sections) {
    const separator = section.indexOf('\r\n\r\n');
    if (separator === -1) continue;
    const rawHeaders = section.subarray(0, separator).toString('utf8');
    let data = section.subarray(separator + 4);
    if (data.subarray(data.length - 2).toString('ascii') === '\r\n') data = data.subarray(0, data.length - 2);
    const disposition = rawHeaders.match(/Content-Disposition:\s*form-data;([^\r\n]*)/i);
    if (!disposition) continue;
    const name = disposition[1].match(/name="([^"]*)"/)?.[1] || '';
    const filename = disposition[1].match(/filename="([^"]*)"/)?.[1];
    parts.push({ name, filename, data });
  }
  return parts;
}

function createStudio(options = {}) {
  const monetProfile = validateMonetProfile(options.monetProfile);
  const store = options.store || createConfigStore();
  const transport = options.transport || fetch;
  const upstreamRequest = options.upstreamRequest || https.request;
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const monetLibrary = createMonetLibrary({ file: path.join(dataDir, 'monet-library.json'), transport });
  const interaction = createInteraction({ store, transport, dataDir });
  /* 互动影游 NPC 对话引擎（夏栀/小满好感度线）：独立于直播互动调度，同一 LLM/TTS 配置 */
  const npcGame = createNpcGame({ store, transport, dataDir });
  const effects = createEffects({ dataDir, transport, dryRun: true, allowLocalFiles: true });
  const mvStudio = createMvStudio({ dataDir, transport });
  const sessions = new Map();
  const web = path.join(__dirname, 'web');
  const videosDir = path.join(dataDir, 'videos');
  /** 校验并解析已上传视频（防目录穿越） */
  function videoFile(name) {
    if (!/^[\w\u4e00-\u9fa5·-]+\.(mp4|webm|mov|m4v)$/i.test(name || '')) throw Object.assign(new Error('非法视频文件名'), { status: 400 });
    const file = path.join(videosDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Object.assign(new Error('视频不存在'), { status: 404 });
    return file;
  }
  let creating = false;
  let turning = false;
  let cloning = false;
  const publicOrigin = (process.env.S2_PUBLIC_ORIGIN || '').trim();
  let publicUrl = null;
  if (publicOrigin) {
    try { publicUrl = new URL(publicOrigin); } catch { throw new Error('S2_PUBLIC_ORIGIN 不是合法 URL'); }
    if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('S2_PUBLIC_ORIGIN 仅支持 http/https');
  }
  const allowed = request => {
    const port = server.address()?.port;
    const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
    const host = request.headers.host;
    const local = hosts.has(host);
    const publicHost = Boolean(publicUrl && host === publicUrl.host);
    if (!local && !publicHost) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    return (local && [...hosts].some(value => origin === `http://${value}`)) ||
      (publicHost && origin === publicUrl.origin);
  };
  function safeError(error) {
    let message = error.message || '请求失败';
    try {
      const config = store.load();
      for (const secret of [config.vidu.api_key, config.llm.api_key, config.minimax.api_key, config.soul.api_key, config.vlm.api_key, config.rtc.trtc.secret_key, config.rtc.artc.app_key, config.rtc.agora.app_certificate]) {
        if (secret) message = message.split(secret).join('[已隐藏]');
      }
    } catch { return '配置文件无法读取，请检查本机config.json格式'; }
    return message;
  }
  function outfits() {
    if (!fs.existsSync(dataDir)) return [];
    return fs.readdirSync(dataDir).filter(name => /^[a-f\d]{64}\.json$/.test(name)).map(name => {
      const item = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
      return { id: item.id, name: item.name, kind: item.kind || 'avatar', persona_id: item.persona_id || '', created_at: item.created_at, preview: `/api/outfits/${item.id}/image` };
    }).sort((first, second) => second.created_at.localeCompare(first.created_at));
  }
  function outfit(id) {
    if (!/^[a-f\d]{64}$/.test(id || '')) throw new Error('造型ID不合法');
    const file = path.join(dataDir, `${id}.json`);
    if (!fs.existsSync(file)) throw Object.assign(new Error('造型不存在'), { status: 404 });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  function importOutfit(body) {
    const { id: contentId } = imageData(body.image_uri);
    const id = crypto.createHash('sha256').update(`${body.kind || 'avatar'}:${contentId}`).digest('hex');
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) throw new Error('造型名称须为1至60字');
    if (outfits().length >= 30 && !fs.existsSync(path.join(dataDir, `${id}.json`))) throw new Error('造型库最多保留30张，请先删除旧造型');
    if (!['avatar', 'reference'].includes(body.kind || 'avatar')) throw new Error('图片用途不正确');
    const personaId = body.persona_id ? (getPersona(body.persona_id) ? body.persona_id : (() => { throw new Error('人设ID不正确'); })()) : '';
    fs.mkdirSync(dataDir, { recursive: true });
    const item = { id, name: body.name.trim(), kind: body.kind || 'avatar', persona_id: personaId, image_uri: body.image_uri, created_at: new Date().toISOString() };
    fs.writeFileSync(path.join(dataDir, `${id}.json`), JSON.stringify(item), { mode: 0o600 });
    return { id, name: item.name, kind: item.kind, preview: `/api/outfits/${id}/image` };
  }
  async function vidu(config, method, resource, body) {
    const response = await transport(`https://${config.vidu.host}${resource}`, {
      method,
      headers: { Authorization: /^(Token|Bearer)\s/i.test(config.vidu.api_key) ? config.vidu.api_key : `Token ${config.vidu.api_key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw Object.assign(new Error(`Vidu返回HTTP ${response.status}，请检查账号权限与RTC配置`), { status: 502 });
    return response.json();
  }
  async function route(request, response) {
    if (!allowed(request)) return json(response, 403, { error: '仅允许本机同源访问' });
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    if (request.method === 'GET' && pathname === '/api/health') return json(response, 200, { service: 's2-live-studio', ok: true, appearance: appearance.capabilities(), readiness: store.view().readiness });
    if (request.method === 'GET' && pathname === '/api/config') return json(response, 200, { ...store.view(), appearance: appearance.capabilities() });
    if (request.method === 'GET' && pathname === '/api/monet') return json(response, 200, { ...getManifest(), ...(monetProfile ? { persona: monetProfile.persona } : {}), library: monetLibrary.status(store.load()) });
    if (request.method === 'GET' && pathname === '/api/monet/library') return json(response, 200, monetLibrary.status(store.load()));
    if (request.method === 'POST' && pathname === '/api/monet/library') {
      await readJson(request);
      if (sessions.size || creating || turning) return json(response, 409, { error: '请先结束直播和试听，再准备动作库' });
      return json(response, 200, await monetLibrary.prepare(store.load()));
    }
    if (request.method === 'POST' && pathname === '/api/monet/avatar') {
      await readJson(request);
      if (sessions.size || creating) return json(response, 409, { error: '请先结束直播，再载入已有公开人物图' });
      const image = fs.readFileSync(path.join(__dirname, 'assets/monet-avatar.webp'));
      const imported = importOutfit({ name: '莫奈 · 已有公开人物图', image_uri: `data:image/webp;base64,${image.toString('base64')}` });
      return json(response, 201, { ...imported, confirmed_requirements: ['hair', 'collar'] });
    }
    if (request.method === 'POST' && pathname === '/api/config') {
      const patch = await readJson(request);
      if (sessions.size || creating || turning || monetLibrary.status(store.load()).busy) return json(response, 409, { error: '请先结束直播、试听或动作库准备，再修改连接设置' });
      return json(response, 200, store.save(patch));
    }
    if (request.method === 'GET' && pathname === '/api/outfits') return json(response, 200, { items: outfits() });
    if (request.method === 'POST' && pathname === '/api/outfits/import') {
      const body = await readJson(request);
      return json(response, 201, importOutfit(body));
    }
    const imageMatch = pathname.match(/^\/api\/outfits\/([a-f\d]{64})\/image$/);
    if (request.method === 'GET' && imageMatch) {
      const decoded = imageData(outfit(imageMatch[1]).image_uri);
      response.writeHead(200, { 'Content-Type': decoded.type, 'Content-Length': decoded.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return response.end(decoded.bytes);
    }
    const removeMatch = pathname.match(/^\/api\/outfits\/([a-f\d]{64})$/);
    if (request.method === 'DELETE' && removeMatch) {
      if ([...sessions.values()].some(session => session.outfit_id === removeMatch[1])) throw new Error('不能删除正在直播的造型');
      outfit(removeMatch[1]);
      fs.unlinkSync(path.join(dataDir, `${removeMatch[1]}.json`));
      return json(response, 200, { ok: true });
    }
    // 造型 ↔ 人设绑定：同一套装里形象、音色、动作一起切换
    const bindMatch = pathname.match(/^\/api\/outfits\/([a-f\d]{64})\/bind$/);
    if (request.method === 'POST' && bindMatch) {
      const body = await readJson(request);
      if (body.persona_id !== null && body.persona_id !== '' && !getPersona(body.persona_id)) throw new Error('人设ID不正确');
      const item = outfit(bindMatch[1]);
      item.persona_id = body.persona_id || '';
      fs.writeFileSync(path.join(dataDir, `${bindMatch[1]}.json`), JSON.stringify(item), { mode: 0o600 });
      return json(response, 200, { id: item.id, persona_id: item.persona_id });
    }
    function boundOutfit(personaId) {
      const hit = outfits().find(item => item.kind !== 'reference' && item.persona_id === personaId);
      return hit ? { id: hit.id, name: hit.name, preview: hit.preview } : null;
    }
    if (request.method === 'POST' && pathname === '/api/live') {
      if (creating || sessions.size) return json(response, 409, { error: '已有直播正在创建或运行，请先结束，避免重复计费' });
      const body = await readJson(request);
      if (creating || sessions.size) return json(response, 409, { error: '已有直播正在创建或运行，请先结束，避免重复计费' });
      const readiness = store.view().readiness;
      const missing = Object.keys(readiness).filter(key => !readiness[key]);
      if (missing.length) return json(response, 503, { error: `请先配置：${missing.join('、')}` });
      const config = store.load();
      if (body.experience !== undefined && !['studio', 'monet'].includes(body.experience)) throw new Error('交互模式不正确');
      const library = monetLibrary.status(config);
      if (library.busy) return json(response, 409, { error: '请等待动作库准备完成再开播' });
      if (body.experience === 'monet' && !library.ready) return json(response, 409, { error: '请先准备莫奈动作库；不将默认动作库的未知覆盖范围冒充为50项支持' });
        const image = imageUri(body.outfit_id ? outfit(body.outfit_id).image_uri : body.image_uri || config.live.image_uri);
        // 动作匹配：开播即绑平台默认动作库（library_id "0"），含静默自然小动作；人设文本注入帮助动作更贴合风格
        const activePersona = getPersona(interaction.snapshot().config.persona_id);
        const personaText = activePersona ? `${styleInstruction(activePersona)}`.slice(0, 20000) : '';
        creating = true;
        try {
          const suffix = crypto.randomBytes(6).toString('hex');
          const channelId = `s2-${suffix}`;
          const push = signToken(config.rtc.provider, config.rtc, channelId, `push-${suffix}`);
          const viewer = signToken(config.rtc.provider, config.rtc, channelId, `viewer-${suffix}`);
          const created = await vidu(config, 'POST', '/live/s_avatar/component', {
            model: 'vidu-s2',
            image_uri: image,
            action: body.experience === 'monet'
              ? { enabled: true, library_id: library.library_id }
              : { enabled: true, library_id: '0' },
            ...(personaText ? { persona: personaText } : {}),
            ...(body.experience === 'monet' ? { avatar: { action_prompt: monetProfile?.action_style || ACTION_STYLE } } : {}),
            customer_rtc: { provider: config.rtc.provider, app_id: push.app_id, channel_id: channelId, user_id: push.user_id, token: push.token },
          });
        if (!created.live?.id || (typeof created.live.id === 'number' && !Number.isSafeInteger(created.live.id)) || !/^\d+$/.test(String(created.live.id))) throw new Error('Vidu创建结果缺少无损live.id，请在控制台检查是否已创建，勿重复点击开播');
        const id = String(created.live.id);
        sessions.set(id, { config, experience: body.experience || 'studio', kind: 'avatar', push, socket: null, connecting: false, outfit_id: body.outfit_id, created_at: Date.now() });
        return json(response, 201, { live: { id, status: created.live.status, trace_id: created.live.trace_id }, viewer, push_user_id: push.user_id });
      } catch (error) {
        if (['TimeoutError', 'TypeError'].includes(error.name)) throw Object.assign(new Error('创建请求未能确认结果，请到Vidu控制台检查是否已创建直播；不要直接重试，以免重复计费', { cause: error }), { status: 502 });
        throw error;
      } finally { creating = false; }
    }
    const editingMatch = pathname.match(/^\/api\/live\/(\d+)\/editing$/);
    if (editingMatch && request.method === 'POST') {
      const parent = sessions.get(editingMatch[1]);
      if (!parent || parent.kind !== 'avatar' || !parent.socket) return json(response, 409, { error: '请先连接Avatar直播' });
      if (parent.editingCreating || [...sessions.values()].some(session => session.parent_id === editingMatch[1])) return json(response, 409, { error: 'Editing已创建，请通过换图信令切换参考图' });
      const input = await readJson(request);
      if (parent.editingCreating || !sessions.has(editingMatch[1]) || [...sessions.values()].some(session => session.parent_id === editingMatch[1])) return json(response, 409, { error: 'Editing已在创建或直播已结束' });
      const image = outfit(input.reference_id).image_uri;
      const token = signToken(parent.config.rtc.provider, parent.config.rtc, parent.push.channel_id, `edit-${crypto.randomBytes(6).toString('hex')}`);
      const payload = appearance.editingBody(image, token, parent.push.user_id, input.editing_type);
      parent.editingCreating = true;
      try {
        const created = await vidu(parent.config, 'POST', '/live/s_editing/realtime', payload);
        if (!created.live?.id || (typeof created.live.id === 'number' && !Number.isSafeInteger(created.live.id)) || !/^\d+$/.test(String(created.live.id))) throw new Error('Editing创建结果缺少无损live.id，请核查平台控制台');
        const id = String(created.live.id);
        sessions.set(id, { config: parent.config, kind: 'editing', parent_id: editingMatch[1], socket: null, connecting: false, outfit_id: input.reference_id, client_secret: created.client_secret || '', render_uid: created.render_uid ? String(created.render_uid) : token.user_id, created_at: Date.now() });
        return json(response, 201, { live: { id, status: created.live.status }, output_user_id: token.user_id, input_user_id: parent.push.user_id, render_uid: created.render_uid ? String(created.render_uid) : token.user_id, client_secret: created.client_secret || '' });
      } catch (error) {
        if (['TimeoutError', 'TypeError'].includes(error.name)) throw Object.assign(new Error('Editing创建结果未确认，请到Vidu控制台检查，勿直接重复创建', { cause: error }), { status: 502 });
        throw error;
      } finally { parent.editingCreating = false; }
    }
    const referenceMatch = pathname.match(/^\/api\/outfits\/([a-f\d]{64})\/reference$/);
    if (referenceMatch && request.method === 'GET') return json(response, 200, { image_uri: outfit(referenceMatch[1]).image_uri });
    const liveMatch = pathname.match(/^\/api\/live\/(\d+)$/);
    if (liveMatch && request.method === 'GET') {
      const session = sessions.get(liveMatch[1]);
      if (!session) return json(response, 404, { error: '本地直播不存在' });
      const data = await vidu(session.config, 'GET', `/live/v1/lives/${liveMatch[1]}`);
      return json(response, 200, { live: { id: data.live?.id, status: data.live?.status, close_reason: data.live?.close_reason } });
    }
    const closeMatch = pathname.match(/^\/api\/live\/(\d+)\/close$/);
    if (closeMatch && request.method === 'POST') {
      for (const [id, child] of sessions) {
        if (child.parent_id === closeMatch[1]) { child.socket?.destroy(); child.upstream?.destroy(); sessions.delete(id); }
      }
      const session = sessions.get(closeMatch[1]);
      session?.socket?.destroy();
      session?.upstream?.destroy();
      sessions.delete(closeMatch[1]);
      return json(response, 200, { ok: true });
    }
    if (request.method === 'GET' && pathname === '/api/interaction') return json(response, 200, interaction.snapshot());
    if (request.method === 'GET' && pathname === '/api/interaction/config') return json(response, 200, interaction.snapshot());
    if (request.method === 'POST' && pathname === '/api/interaction/config') {
      const patch = await readJson(request);
      if (patch.effects_dry_run !== undefined) effects.setDryRun(Boolean(patch.effects_dry_run));
      // 中控台直接切音色档案：Soul 克隆音色与 MiniMax 回落音色一起写（直播中也可用，不走 /api/config 的互斥限制）；
      // 显式挑了某个音色 = 记住这个性别偏好（voice_gender），之后切人设也优先沿用同性别音色
      if (patch.voice_id && typeof store.save === 'function') {
        const profile = getVoice(patch.voice_id);
        if (profile) { store.save(patchForVoice(profile)); delete patch.voice_id; patch.voice_gender = profile.gender; }
      } else if (patch.voice_gender !== undefined && !patch.persona_id && typeof store.save === 'function') {
        // 只改性别偏好：按当前人设解析该性别对应的音色档案并立即生效
        const current = getPersona(interaction.snapshot().config.persona_id);
        const gender = ['female', 'male'].includes(patch.voice_gender) ? patch.voice_gender : current?.gender;
        const voice = voiceForPersona(current, gender);
        if (voice) store.save(patchForVoice(voice));
      }
      // 人设切换时按性别偏好（缺省跟人设本身性别）同步音色档案（Soul 与 MiniMax 两侧一起切）
      const switchingPersona = Boolean(patch.persona_id) && patch.persona_id !== interaction.snapshot().config.persona_id;
      if (patch.persona_id && typeof store.save === 'function') {
        const person = getPersona(patch.persona_id);
        const gender = ['female', 'male'].includes(patch.voice_gender) ? patch.voice_gender
          : (['female', 'male'].includes(interaction.snapshot().config.voice_gender) ? interaction.snapshot().config.voice_gender : person?.gender);
        const voice = voiceForPersona(person, gender);
        if (voice) store.save(patchForVoice(voice));
      }
      const manifest = interaction.updateConfig(patch);
      if (switchingPersona) manifest.bound_outfit = boundOutfit(patch.persona_id);
      return json(response, 200, manifest);
    }
    if (request.method === 'POST' && pathname === '/api/interaction/event') {
      const input = await readJson(request, 128 * 1024);
      if (typeof input.type !== 'string') throw new Error('缺少事件类型 type');
      return json(response, 200, await interaction.handleEvent(input));
    }
    if (request.method === 'POST' && pathname === '/api/interaction/tick') {
      const tickBody = await readJson(request, 4096).catch(() => ({}));
      const result = await interaction.tick({ force_cold_start: Boolean(tickBody.force_cold_start) });
      /* 静默小动作（type9 画面轨）：非 plan 结果也要透传给前端，由浏览器 sendAction 上行 */
      if (result?.idle_motion) return json(response, 200, { idle: { actions: result.actions, trigger: result.trigger } });
      return json(response, 200, result ? { plan: result } : { skip: true, state: interaction.snapshotState() });
    }
    if (request.method === 'GET' && pathname === '/api/interaction/log') return json(response, 200, { audit: interaction.snapshot().audit, state: interaction.snapshotState() });
    /* ---------- 互动影游 NPC 对话（夏栀/小满：开局选项 → 自由夜谈 → 好感度事件 → 记忆库） ---------- */
    if (request.method === 'GET' && pathname === '/api/npc/game') {
      const snapshot = npcGame.snapshot();
      return json(response, 200, snapshot || { active: false, note: '影游会话未开始，POST /api/npc/game/start 开局' });
    }
    if (request.method === 'POST' && pathname === '/api/npc/game/start') {
      const input = await readJson(request, 4096).catch(() => ({}));
      return json(response, 200, npcGame.start(input));
    }
    if (request.method === 'POST' && pathname === '/api/npc/game/choose') {
      const input = await readJson(request, 4096);
      if (typeof input.choice !== 'string') throw Object.assign(new Error('缺少开局选项 choice'), { status: 400 });
      return json(response, 200, npcGame.choose(input.choice));
    }
    if (request.method === 'POST' && pathname === '/api/npc/game/switch') {
      const input = await readJson(request, 4096);
      if (typeof input.target !== 'string') throw Object.assign(new Error('缺少对话对象 target'), { status: 400 });
      return json(response, 200, npcGame.switchSpeaker(input.target));
    }
    if (request.method === 'POST' && pathname === '/api/npc/game/topic') {
      const input = await readJson(request, 4096);
      if (typeof input.topic !== 'string') throw Object.assign(new Error('缺少追问话题 topic'), { status: 400 });
      const result = await npcGame.askTopic(input.topic);
      const config = store.load();
      if (!config.minimax.api_key && !config.soul.api_key) return json(response, 200, { ...result, audio: null, format: null });
      try {
        const audio = result.reply ? await synthesizeWithFallback(config, result.reply, undefined, transport) : {};
        return json(response, 200, { ...result, audio: audio.audio || null, format: audio.format || null, duration_ms: audio.duration_ms || null });
      } catch (error) {
        return json(response, 200, { ...result, audio: null, format: null, audio_error: error.message });
      }
    }
    if (request.method === 'POST' && pathname === '/api/npc/game/offer') {
      const input = await readJson(request, 4096);
      if (typeof input.offer !== 'string') throw Object.assign(new Error('缺少道具 offer'), { status: 400 });
      const result = npcGame.offer(input.offer, input.variant);
      const config = store.load();
      if (!config.minimax.api_key && !config.soul.api_key) return json(response, 200, { ...result, audio: null, format: null });
      try {
        const audio = result.text ? await synthesizeWithFallback(config, result.text, undefined, transport) : {};
        return json(response, 200, { ...result, audio: audio.audio || null, format: audio.format || null, duration_ms: audio.duration_ms || null });
      } catch (error) {
        return json(response, 200, { ...result, audio: null, format: null, audio_error: error.message });
      }
    }
    if (request.method === 'POST' && pathname === '/api/npc/game/end') {
      await readJson(request, 4096).catch(() => ({}));
      return json(response, 200, npcGame.end());
    }
    if (request.method === 'POST' && pathname === '/api/npc/game/say') {
      const input = await readJson(request, 64 * 1024);
      if (typeof input.text !== 'string') throw Object.assign(new Error('缺少玩家发言 text'), { status: 400 });
      const result = await npcGame.say(input.text);
      /* 回台词 TTS：沿用主备合成（Soul 优先 → MiniMax 回落），拟声标签只走 MiniMax 链路 */
      const config = store.load();
      if (!config.minimax.api_key && !config.soul.api_key) return json(response, 200, { ...result, audio: null, format: null });
      try {
        const audio = result.reply ? await synthesizeWithFallback(config, result.reply, undefined, transport) : {};
        return json(response, 200, { ...result, audio: audio.audio || null, format: audio.format || null, duration_ms: audio.duration_ms || null });
      } catch (error) {
        return json(response, 200, { ...result, audio: null, format: null, audio_error: error.message });
      }
    }
    if (request.method === 'POST' && pathname === '/api/effect/dance') {
      const input = await readJson(request, 10 * 1024 * 1024);
      if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('缺少主播形象图 image_uri');
      if (input.fx !== undefined && !GIFT_FX[input.fx]) throw Object.assign(new Error(`未知特效 fx=${input.fx}，可用：${Object.keys(GIFT_FX).join('/')}`), { status: 400 });
      return json(response, 201, await effects.createTask(store.load(), input));
    }
    if (request.method === 'POST' && pathname === '/api/effect/motion-sync') {
      const input = await readJson(request, 10 * 1024 * 1024);
      if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('缺少人物形象图 image_uri');
      /* 本地上传的跳舞参考视频：local:// 引用服务端文件（免去公网 URL 中转） */
      if (input.video_name) input.video_url = `local://${videoFile(input.video_name).replace(/\\/g, '/')}`;
      else if (typeof input.video_url !== 'string' || !input.video_url) throw new Error('缺少动作参考视频 video_url');
      return json(response, 201, await effects.createMotionSync(store.load(), input));
    }
    /* 礼物点击 → 后台真实生成直播特效（映射 GIFT_FX 具名模板，绕过 dry_run，完成后前端覆盖播放） */
    if (request.method === 'POST' && pathname === '/api/gift/fx') {
      const input = await readJson(request, 10 * 1024 * 1024);
      if (typeof input.gift !== 'string' || !input.gift) throw new Error('缺少礼物名 gift');
      if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('缺少主播形象图 image_uri');
      const fx = mapGiftFx(input.gift);
      if (!fx) throw Object.assign(new Error(`礼物「${input.gift.slice(0, 20)}」未映射到直播特效模板（可用：${Object.keys(GIFT_FX).join('/')}）`), { status: 400 });
      return json(response, 201, await effects.createTask(store.load(), { kind: 'effect', fx, image_uri: input.image_uri, real: true }));
    }
    if (request.method === 'GET' && pathname === '/api/effect/status') return json(response, 200, effects.status());
    const effectTask = pathname.match(/^\/api\/effect\/task\/([\w-]+)$/);
    if (request.method === 'GET' && effectTask) return json(response, 200, await effects.refreshTask(store.load(), effectTask[1]));
    /* ---------- 图生视频（Q4 Preview）：主播形象图作首帧入参图 ---------- */
    if (request.method === 'POST' && pathname === '/api/i2v/create') {
      const input = await readJson(request, 8 * 1024 * 1024);
      if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('缺少入参图 image_uri（用当前主播形象图）');
      return json(response, 201, await effects.createImg2Video(store.load(), input));
    }
    /* ---------- 直播小游戏（数字炸弹/拆弹剪线）状态查询 ---------- */
    if (request.method === 'GET' && pathname === '/api/games/status') return json(response, 200, interaction.gamesStatus());
    /* ---------- 唱歌（音乐库 + 一键 MV） ---------- */
    if (request.method === 'GET' && pathname === '/api/sing/music') {
      const config = store.load();
      const dir = config.singing?.music_dir || '';
      if (!dir || !fs.existsSync(dir)) return json(response, 200, { items: [], music_dir: dir, note: '音乐目录不存在' });
      const items = fs.readdirSync(dir)
        .filter(name => /\.(mp3|wav|aac|m4a)$/i.test(name))
        .map(name => { const stat = fs.statSync(path.join(dir, name)); return { name, size: stat.size, mtime: stat.mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
      return json(response, 200, { items, music_dir: dir });
    }
    if (request.method === 'GET' && pathname === '/api/sing/file') {
      const url = new URL(request.url, 'http://localhost');
      const name = url.searchParams.get('name') || '';
      if (!/^[\w\u4e00-\u9fa5·~！！，,\s().&''-]+\.(mp3|wav|aac|m4a)$/i.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return json(response, 400, { error: '非法音乐文件名' });
      }
      const config = store.load();
      const dir = config.singing?.music_dir || '';
      const file = path.join(dir, name);
      if (!dir || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(response, 404, { error: '音乐文件不存在' });
      const type = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4' }[path.extname(name).toLowerCase()] || 'audio/mpeg';
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store' });
      response.end(fs.readFileSync(file));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/mv/create') {
      const input = await readJson(request, 64 * 1024);
      if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('缺少主播形象图 image_uri');
      let music;
      if (input.video_name) {
        /* 本地上传的 MV 视频：直接提取音轨（≤300s）作为歌曲 */
        music = await musicFromVideoFile(videoFile(input.video_name));
      } else if (input.video_url) {
        /* 公开 MV 视频链接：服务端下载 → ffmpeg 提取音轨（≤300s）作为歌曲 */
        music = await musicFromVideoUrl(input.video_url);
      } else {
        if (typeof input.music !== 'string' || !input.music) throw new Error('缺少音乐文件名 music（或提供公开 video_url 自动提取音轨）');
        if (!Number.isFinite(input.duration_s)) throw new Error('缺少音频时长 duration_s（由前端解码得到）');
        const dir = store.load().singing?.music_dir || '';
        const file = path.join(dir, input.music);
        if (!dir || !fs.existsSync(file)) throw new Error('音乐文件不存在');
        music = { name: input.music, buffer: fs.readFileSync(file), duration_s: Number(input.duration_s) };
      }
      const config = store.load();
      const task = await mvStudio.createTask(config, {
        mode: ['sing', 'sing_perform', 'perform', 'dance'].includes(input.mode) ? input.mode : 'sing',
        image_uri: input.image_uri,
        lip_sync: Boolean(input.lip_sync),
        lip_ref_urls: Array.isArray(input.lip_ref_urls) ? input.lip_ref_urls : undefined,
        resolution: input.resolution,
        version: input.version,
        prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
        music,
      });
      return json(response, 201, task);
    }
    const mvTask = pathname.match(/^\/api\/mv\/task\/([\w-]+)$/);
    if (request.method === 'GET' && mvTask) return json(response, 200, await mvStudio.refreshTask(store.load(), mvTask[1]));
    if (request.method === 'GET' && pathname === '/api/mv/status') return json(response, 200, mvStudio.status());
    /* ---------- 本地上传视频（MV 成片 / 跳舞参考，原始二进制直传 ≤120MB） ---------- */
    if (request.method === 'POST' && pathname === '/api/video/upload') {
      const rawName = decodeURIComponent(String(request.headers['x-filename'] || '')).replace(/[\\/]+/g, '_').trim();
      if (!rawName || !/\.(mp4|webm|mov|m4v)$/i.test(rawName)) throw new Error('仅支持 mp4 / webm / mov / m4v 视频');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 120 * 1024 * 1024) throw Object.assign(new Error('视频超过 120MB 上限'), { status: 413 });
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 1024) throw new Error('视频内容为空');
      fs.mkdirSync(videosDir, { recursive: true });
      const stored = `${Date.now()}-${rawName}`;
      fs.writeFileSync(path.join(videosDir, stored), buffer);
      let duration_s = 0;
      try {
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path.join(videosDir, stored)], { timeout: 60000 });
        duration_s = Number(JSON.parse(stdout).format?.duration) || 0;
      } catch { /* 本机无 ffmpeg 不影响上传，时长留 0 */ }
      const files = fs.readdirSync(videosDir).map(name => ({ name, at: fs.statSync(path.join(videosDir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
      for (const old of files.slice(20)) { try { fs.unlinkSync(path.join(videosDir, old.name)); } catch { /* 占用则跳过 */ } }
      return json(response, 201, { name: stored, url: `/media/videos/${encodeURIComponent(stored)}`, size: buffer.length, duration_s });
    }
    /* ---------- 录屏 webm → mp4 转码（服务端 ffmpeg；成功后默认清理源文件） ---------- */
    if (request.method === 'POST' && pathname === '/api/media/transcode') {
      const input = await readJson(request, 4096);
      const src = videoFile(decodeURIComponent(String(input.file || '').replace(/^\/media\/videos\//, '')));
      const outName = `${src.replace(/\.\w+$/i, '')}.mp4`;
      if (path.resolve(src) === path.resolve(outName)) return json(response, 200, { url: `/media/videos/${encodeURIComponent(path.basename(src))}`, transcoded: false });
      const tmp = `${outName}.tmp.mp4`;
      try {
        await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], { timeout: 600000 });
        fs.renameSync(tmp, outName);
      } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* 不存在则忽略 */ }
        if (error.code === 'ENOENT') throw new Error('服务端未安装 ffmpeg，无法转码');
        throw new Error(`转码失败：${String(error.stderr || error.message).slice(0, 200)}`);
      }
      if (input.cleanup !== false) { try { fs.unlinkSync(src); } catch { /* 占用则跳过 */ } }
      return json(response, 200, { url: `/media/videos/${encodeURIComponent(path.basename(outName))}`, transcoded: true });
    }
    /* ---------- 视频时长探测（Motion Sync 拆分模式：远程/已上传视频 → 时长，供 12s 拆段） ---------- */
    if (request.method === 'GET' && pathname === '/api/media/probe') {
      const raw = String(new URL(request.url, 'http://x').searchParams.get('url') || '').trim();
      if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/media/videos/')) throw new Error('需要 http(s) 或已上传视频链接');
      let duration_s = 0;
      let tmpFile = null;
      try {
        let target = null;
        if (raw.startsWith('/media/videos/')) target = videoFile(decodeURIComponent(raw.replace(/^\/media\/videos\//, '')));
        else {
          /* 静态 ffprobe 直接读 http 会 core dump：先落到 /tmp 再探测（限 64MB，超限不探测） */
          tmpFile = path.join(os.tmpdir(), `probe-${Date.now()}.mp4`);
          const res = await fetch(raw, { signal: AbortSignal.timeout(30000) });
          if (!res.ok) throw new Error(`视频拉取失败 HTTP ${res.status}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length > 64 * 1024 * 1024) throw new Error('视频超过 64MB，跳过时长探测');
          fs.writeFileSync(tmpFile, buffer);
          target = tmpFile;
        }
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', target], { timeout: 60000 });
        duration_s = Number(JSON.parse(stdout).format?.duration) || 0;
      } catch { /* 探测失败返回 0，前端按默认 12s 拆 */ }
      finally { if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* 忽略 */ } } }
      return json(response, 200, { duration_s });
    }
    const mediaMatch = pathname.match(/^\/media\/videos\/(.+)$/);
    if (request.method === 'GET' && mediaMatch) {
      const file = videoFile(decodeURIComponent(mediaMatch[1]));
      const size = fs.statSync(file).size;
      const type = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' }[path.extname(file).toLowerCase()] || 'video/mp4';
      const range = String(request.headers.range || '').match(/bytes=(\d*)-(\d*)/);
      if (range && (range[1] !== '' || range[2] !== '')) {
        const start = range[1] === '' ? 0 : Number(range[1]);
        const end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
        if (!Number.isInteger(start) || start > end || start >= size) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return response.end();
        }
        response.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
        return fs.createReadStream(file, { start, end }).pipe(response);
      }
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).pipe(response);
    }
    /* ---------- 音色克隆：上传参考音频（mp3/wav/m4a ≤20MB），调 Soul/MiniMax/Qwen 克隆 ---------- */
    if (request.method === 'POST' && pathname === '/api/voice/clone') {
      if (cloning) return json(response, 409, { error: '上一条克隆仍在进行，请等待完成' });
      const contentType = String(request.headers['content-type'] || '');
      if (!contentType.startsWith('multipart/form-data')) throw Object.assign(new Error('需要 multipart/form-data 上传'), { status: 415 });
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!boundaryMatch) throw Object.assign(new Error('缺少 multipart boundary'), { status: 400 });
      const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
      const parts = await readMultipart(request, boundary, 20 * 1024 * 1024);
      const fields = {};
      let audio = null;
      let audioName = '';
      for (const part of parts) {
        if (part.filename) { audio = part.data; audioName = part.filename; }
        else fields[part.name] = part.data.toString('utf8');
      }
      if (!audio || !audio.length) throw Object.assign(new Error('请上传参考音频文件'), { status: 400 });
      const provider = String(fields.provider || '').toLowerCase();
      if (!['soul', 'minimax', 'qwen'].includes(provider)) throw Object.assign(new Error('provider 须为 soul / minimax / qwen'), { status: 400 });
      const format = (audioName.split('.').pop() || '').toLowerCase();
      if (!['mp3', 'wav', 'm4a'].includes(format)) throw Object.assign(new Error(`音频格式仅支持 mp3/wav/m4a（当前 ${format || '未知'}）`), { status: 400 });
      if (audio.length < 10 * 1024) throw Object.assign(new Error('参考音频太小，建议 10 秒以上清晰人声'), { status: 400 });
      cloning = true;
      const controller = new AbortController();
      response.on('close', () => { if (!response.writableEnded) controller.abort(); });
      try {
        const result = await cloneVoice(store.load(), {
          provider, audio, format,
          voiceId: String(fields.voice_id || '').trim() || undefined,
          text: String(fields.text || '').trim() || undefined,
          noiseReduction: fields.noise_reduction === 'true',
          dereverberation: fields.dereverberation === 'true',
          volumeNormalization: fields.volume_normalization === 'true',
          signal: controller.signal, transport,
        });
        return json(response, 200, result);
      } finally { cloning = false; }
    }
    /* ---------- 形象 → VLM 识别性别气质 → 匹配音色档案 ---------- */
    if (request.method === 'POST' && pathname === '/api/voice/detect') {
      const input = await readJson(request);
      if (typeof input.image_uri !== 'string' || !input.image_uri) throw new Error('缺少形象图 image_uri');
      const config = store.load();
      const analysis = await detectAvatar(config, input.image_uri);
      const voice = matchVoiceFromAnalysis(analysis, listVoices());
      if (!voice) return json(response, 200, { ...analysis, voice_id: '', voice_name: '', applied: false, note: '未能识别出明确性别，请手动选择音色' });
      // apply=true 时直接写入配置（Soul 与 MiniMax 两侧一起切），直播中也可用
      if (input.apply) store.save(patchForVoice(voice));
      return json(response, 200, { ...analysis, voice_id: voice.id, voice_name: voice.name, applied: Boolean(input.apply) });
    }
    if (request.method === 'POST' && ['/api/turn', '/api/voice/preview', '/api/monet/turn'].includes(pathname)) {
      const input = await readJson(request, 128 * 1024);
      let planned;
      if (pathname === '/api/monet/turn') {
        const session = sessions.get(String(input.live_id));
        if (session?.kind !== 'avatar' || session.experience !== 'monet' || !session.socket) return json(response, 409, { error: '请先以莫奈展台模式开播并连接动作通道' });
        planned = planTurn(input);
        if (input.event === 'turn') validateTurn(input);
      }
      if (pathname === '/api/turn') {
        validateTurn(input);
        if (sessions.get(String(input.live_id))?.kind !== 'avatar') return json(response, 409, { error: '请先开始Avatar直播' });
      }
      if (turning) return json(response, 409, { error: '上一段语音正在生成，请等待或打断后再试' });
      turning = true;
      const controller = new AbortController();
      response.on('close', () => { if (!response.writableEnded) controller.abort(); });
      try {
        let config = store.load();
        // 试听可临时指定音色档案，不必先保存设置
        if (pathname === '/api/voice/preview') {
          const profile = getVoice(input.voice_id);
          const patch = patchForVoice(profile);
          if (profile) config = { ...config, soul: { ...config.soul, ...patch.soul }, minimax: { ...config.minimax, ...patch.minimax } };
        }
        if (!config.minimax.api_key && !config.soul.api_key) return json(response, 503, { error: '请在连接设置中填写 Soul 或 MiniMax API Key' });
        const performed = planned ? await prepareMonet(config, input, controller.signal, transport, monetProfile) : null;
        const text = performed ? performed.text : pathname === '/api/turn' ? await reply(config, input, controller.signal, transport) : input.text;
        const audio = text ? await synthesizeWithFallback(config, text, controller.signal, transport) : {};
        if (!response.destroyed) return json(response, 200, { ...(performed || {}), text, ...audio });
      } finally { turning = false; }
      return;
    }
    if (pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
    if (request.method !== 'GET') return json(response, 405, { error: '仅支持GET' });
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.resolve(web, `.${relative}`);
    if (!file.startsWith(`${web}${path.sep}`)) return json(response, 403, { error: '路径不允许' });
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file)];
    if (!mime || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(response, 404, { error: '文件不存在' });
    response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    fs.createReadStream(file).pipe(response);
  }
  const server = http.createServer((request, response) => {
    route(request, response).catch(error => {
      if (!response.headersSent && !response.destroyed) json(response, error.status || 400, { error: safeError(error) });
      else if (!response.destroyed) response.end();
    });
  });
  server.on('upgrade', (request, client, head) => {
    const reject = status => client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (!allowed(request)) return reject('403 Forbidden');
    const url = new URL(request.url, 'http://localhost');
    const id = url.searchParams.get('live_id');
    const session = sessions.get(id);
    if (url.pathname !== '/ws/live' || !session || !/^\d+$/.test(id)) return reject('404 Not Found');
    if (session.socket || session.connecting) return reject('409 Conflict');
    session.connecting = true;
    const target = new URL(`https://${session.config.vidu.host}${session.kind === 'editing' ? '/live/ws/live/connect' : `/live/v1/external-lives/${id}/stream`}`);
    if (session.kind === 'editing') target.searchParams.set('live_id', id);
    target.searchParams.set('conn_id', (url.searchParams.get('conn_id') || '').replace(/[^\w.-]/g, '').slice(0, 64));
    const upstream = upstreamRequest(target, {
      headers: { Authorization: session.kind === 'editing' ? session.config.vidu.api_key.replace(/^(Token|Bearer)\s+/i, '') : /^(Token|Bearer)\s/i.test(session.config.vidu.api_key) ? session.config.vidu.api_key : `Token ${session.config.vidu.api_key}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': request.headers['sec-websocket-key'] },
    });
    session.upstream = upstream;
    let tunnel;
    const cleanup = () => {
      clearTimeout(timer);
      tunnel?.destroy();
      client.destroy();
      upstream.destroy();
      sessions.delete(id);
      if (session.kind === 'avatar') {
        for (const [childId, child] of sessions) {
          if (child.parent_id === id) { child.socket?.destroy(); child.upstream?.destroy(); sessions.delete(childId); }
        }
      }
    };
    const timer = setTimeout(cleanup, 20000);
    client.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('upgrade', (upResponse, socket, upstreamHead) => {
      clearTimeout(timer);
      if (client.destroyed) { socket.destroy(); return; }
      tunnel = socket;
      session.connecting = false;
      session.socket = socket;
      client.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${upResponse.headers['sec-websocket-accept']}\r\n\r\n`);
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) socket.write(head);
      client.setNoDelay(true);
      socket.setNoDelay(true);
      client.pipe(socket).pipe(client);
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    });
    upstream.on('response', upstreamResponse => {
      upstreamResponse.resume();
      reject(`${upstreamResponse.statusCode || 502} Upstream rejected`);
      clearTimeout(timer);
      sessions.delete(id);
    });
    upstream.on('error', cleanup);
    upstream.end();
  });
  server.on('close', () => {
    for (const session of sessions.values()) { session.socket?.destroy(); session.upstream?.destroy(); }
    sessions.clear();
  });
  return server;
}

if (require.main === module) {
  const portFlag = process.argv.indexOf('--port');
  const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.S2_PORT || 8792);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口须在1024至65535之间');
  const server = createStudio();
  server.listen(port, '127.0.0.1', () => console.log(`S2 Live Studio: http://localhost:${port}`));
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => server.close(() => process.exit(0)));
}

module.exports = { createStudio };
