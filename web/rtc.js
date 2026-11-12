/**
 * RTC 观看端（viewer）适配层：只订阅远端，不推流。
 *
 * 数字人是 Vidu 侧推进频道的，本页只做拉流渲染。三家的调用方式取自
 * 可跑通的参考实现，尽量不改动。
 *
 * 本文件不接触任何签名密钥：token 由本地服务签发后经 /api/rtc-token 下发。
 */

const GSLB_DEFAULT = 'https://rgslb.rtc.aliyuncs.com';

/**
 * 阿里 ARTC 的 token 形态有两种可能，取决于服务端签发实现：
 *   'raw'      — 直接把签名串交给 joinChannel
 *   'authinfo' — 包一层 JSON 信封（appid/channelid/userid/timestamp/token）
 * 参考实现里服务端函数不可见，所以两种都支持，页面上可一键切换。
 */
export function buildArtcJoinToken(tokenInfo, shape) {
  if (shape === 'raw') return tokenInfo.token;
  return JSON.stringify({
    appid: tokenInfo.app_id,
    channelid: tokenInfo.channel_id,
    userid: tokenInfo.user_id,
    timestamp: Number(tokenInfo.timestamp),
    token: tokenInfo.token,
    gslb: [GSLB_DEFAULT],
  });
}

export class RtcViewer {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.videoEl
   * @param {(msg:string, level?:string)=>void} [opts.onLog]
   * @param {(uid:string)=>void} [opts.onRemote] 远端用户入会回调
   * @param {(proof:object)=>void} [opts.onMediaVerified] 远端视频完成真实解码回调
   */
  constructor(opts) {
    this.videoEl = opts.videoEl;
    this.onLog = opts.onLog || (() => {});
    this.onRemote = opts.onRemote || (() => {});
    this.onMediaVerified = opts.onMediaVerified || (() => {});
    this.provider = null;
    this.engine = null;
    this.client = null;
    this.verifyVersion = 0;
    this.verifyingUsers = new Set();
    this.targetUserId = opts.targetUserId || '';
    this.audioUserId = opts.audioUserId || '';
    this.primaryAudioUserId = this.audioUserId;
    this.audioUsers = new Set();
    this.audioQueue = Promise.resolve();
    this.remoteStreams = new Map();
    this.activeVideo = null;
    this.videoQueue = Promise.resolve();
  }

  async join(provider, tokenInfo, opts = {}) {
    this.provider = provider;
    if (provider === 'agora') return this._joinAgora(tokenInfo);
    if (provider === 'trtc') return this._joinTrtc(tokenInfo);
    return this._joinArtc(tokenInfo, opts.artcTokenShape || 'authinfo');
  }

  // ───────────────── 阿里 ARTC ─────────────────

  async _joinArtc(tokenInfo, tokenShape) {
    if (!window.AliRtcEngine) throw new Error('AliRTC Web SDK 未加载（检查网络能否访问 g.alicdn.com）');
    const supported = await window.AliRtcEngine.isSupported();
    if (!supported.support) throw new Error(`当前浏览器不支持 AliRTC: ${supported.reason || 'unknown'}`);

    window.AliRtcEngine.setLogLevel(0);
    const engine = window.AliRtcEngine.getInstance();
    this.engine = engine;

    engine.on('remoteUserOnLineNotify', (userId) => {
      this.onLog(`远端用户上线: ${userId}`, 'ok');
      this.onRemote(userId);
    });
    engine.on('remoteUserOffLineNotify', (userId, reason) => {
      this.onLog(`远端用户下线: ${userId} reason=${reason}`, 'warn');
    });
    engine.on('videoSubscribeStateChanged', (userId, _old, next) => {
      if (next === 3) {
        engine.setRemoteViewConfig(this.videoEl, userId, 1);
        this.videoEl.play().catch(() => this.onLog('远端视频未能自动播放，点一下画面', 'warn'));
        this.onLog(`已订阅远端视频: ${userId}`, 'ok');
        this._verifyRemoteMedia(String(userId));
      }
    });
    engine.on('bye', (code) => this.onLog(`AliRTC bye code=${code}`, 'warn'));

    const call = async (m, ...a) => { if (typeof engine[m] === 'function') await engine[m](...a); };
    await call('setChannelProfile', 'communication');
    // viewer 不推流：上行音频走 WebSocket 给 Vidu，不经 RTC
    await call('setDefaultPublishLocalAudioStream', false);
    await call('setDefaultPublishLocalVideoStream', false);
    await call('setDefaultSubscribeAllRemoteAudioStreams', true);
    await call('setDefaultSubscribeAllRemoteVideoStreams', true);

    const joinToken = buildArtcJoinToken(tokenInfo, tokenShape);
    this.onLog(`AliRTC joinChannel（token 形态: ${tokenShape}）`);
    await engine.joinChannel(joinToken, tokenInfo.user_id);
    this.onLog('AliRTC 入会成功，等待数字人推流', 'ok');
  }

  // ───────────────── 声网 Agora ─────────────────

  async _joinAgora(tokenInfo) {
    if (!window.AgoraRTC) throw new Error('Agora Web SDK 未加载');
    if (!AgoraRTC.checkSystemRequirements()) throw new Error('当前浏览器不支持 AgoraRTC');

    const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    this.client = client;

    client.on('user-joined', (user) => {
      this.onLog(`远端用户加入: ${user.uid}`, 'ok');
      this.onRemote(String(user.uid));
    });
    client.on('user-left', (user, reason) => this.onLog(`远端用户离开: ${user.uid} ${reason}`, 'warn'));
    client.on('user-published', async (user, mediaType) => {
      try {
        await client.subscribe(user, mediaType);
        if (mediaType === 'video') {
          // 默认 cover 会把数字人裁掉，必须显式 contain
          user.videoTrack.play(this.videoEl, { fit: 'contain' });
          this.onLog(`已订阅远端视频: ${user.uid}`, 'ok');
          this._verifyRemoteMedia(String(user.uid));
        } else if (mediaType === 'audio') {
          user.audioTrack.play();
        }
      } catch (e) {
        this.onLog(`订阅远端失败: ${e.message}`, 'err');
      }
    });
    client.on('connection-state-change', (cur, prev) => this.onLog(`Agora 连接状态: ${prev} → ${cur}`));

    await client.join(tokenInfo.app_id, tokenInfo.channel_id, tokenInfo.token, tokenInfo.user_id);
    this.onLog('Agora 入会成功，等待数字人推流', 'ok');
  }

  // ───────────────── 腾讯 TRTC ─────────────────

  async _joinTrtc(tokenInfo) {
    if (!window.TRTC) throw new Error('TRTC Web SDK 未加载');
    const client = TRTC.create();
    this.client = client;

    client.on(TRTC.EVENT.REMOTE_USER_ENTER, (e) => {
      this.onLog(`远端用户进入: ${e.userId}`, 'ok');
      this.onRemote(e.userId);
    });
    client.on(TRTC.EVENT.REMOTE_USER_EXIT, (e) => this.onLog(`远端用户离开: ${e.userId}`, 'warn'));
    client.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, async (e) => {
      try {
        this.remoteStreams.set(String(e.userId), e);
        if (!this.targetUserId || this.targetUserId === String(e.userId)) await this.setVideoUser(String(e.userId));
      } catch (err) {
        this.onLog(`播放远端视频失败: ${err.message}`, 'err');
      }
    });
    client.on(TRTC.EVENT.ERROR, (e) => this.onLog(`TRTC 错误 code=${e.code} ${e.message}`, 'err'));
    client.on(TRTC.EVENT.REMOTE_AUDIO_AVAILABLE, (event) => {
      this.audioUsers.add(String(event.userId));
      this._syncAudio().catch(error => this.onLog(error.message, 'err'));
    });
    if (TRTC.EVENT.REMOTE_AUDIO_UNAVAILABLE) client.on(TRTC.EVENT.REMOTE_AUDIO_UNAVAILABLE, (event) => {
      this.audioUsers.delete(String(event.userId));
      this._syncAudio().catch(error => this.onLog(error.message, 'err'));
    });

    // 用字符串房间号，与 artc/agora 的 channel 语义对齐
    await client.enterRoom({
      strRoomId: tokenInfo.channel_id,
      scene: 'rtc',
      sdkAppId: Number(tokenInfo.app_id),
      userId: tokenInfo.user_id,
      userSig: tokenInfo.token,
      autoReceiveAudio: !this.audioUserId,
    });
    if (this.audioUserId) await client.muteRemoteAudio(this.audioUserId, false);
    this.onLog('TRTC 入会成功，等待数字人推流', 'ok');
  }

  async setVideoUser(userId) {
    if (this.provider !== 'trtc') throw new Error('当前组合直播的双流切换支持腾讯TRTC');
    this.targetUserId = String(userId);
    this.verifyVersion++;
    this.verifyingUsers.clear();
    await this._syncAudio();
    const requested = this.targetUserId;
    this.videoQueue = this.videoQueue.catch(() => {}).then(async () => {
      if (this.targetUserId !== requested || !this.client) return;
      const remote = this.remoteStreams.get(requested);
      if (!remote) return;
      if (this.activeVideo && this.activeVideo.userId !== requested) await this.client.stopRemoteVideo({ userId: this.activeVideo.userId, streamType: this.activeVideo.streamType });
      if (this.activeVideo?.userId !== requested) {
        this.videoEl.style.display = 'none';
        await this.client.startRemoteVideo({ userId: remote.userId, streamType: remote.streamType, view: this.videoEl.parentElement, option: { fillMode: 'contain' } });
        this.activeVideo = remote;
      }
      if (this.targetUserId !== requested) return;
      this.onLog(`已订阅远端视频: ${requested}`, 'ok');
      this._verifyRemoteMedia(requested);
    });
    return this.videoQueue;
  }

  async _syncAudio() {
    if (!this.primaryAudioUserId || typeof this.client?.muteRemoteAudio !== 'function') return;
    this.audioQueue = this.audioQueue.catch(() => {}).then(async () => {
      if (!this.client) return;
      const desired = this.audioUsers.has(this.targetUserId) ? this.targetUserId : this.primaryAudioUserId;
      if (this.audioUserId && this.audioUserId !== desired) await this.client.muteRemoteAudio(this.audioUserId, true);
      await this.client.muteRemoteAudio(desired, false);
      this.audioUserId = desired;
    });
    return this.audioQueue;
  }

  async _verifyRemoteMedia(userId) {
    if (this.verifyingUsers.has(userId)) return;
    this.verifyingUsers.add(userId);
    const version = this.verifyVersion;
    try {
      const proof = await this._waitForDecodedFrames(userId, version);
      if (version !== this.verifyVersion) return;
      proof.stats = await this._readRemoteStats(userId);
      this.onLog(
        `真实远端视频已验证: ${proof.width}x${proof.height}，连续解码 ${proof.frames} 帧` +
          (proof.stats ? `，RTC 统计 ${proof.stats}` : ''),
        'ok',
      );
      this.onMediaVerified(proof);
    } catch (error) {
      if (version === this.verifyVersion) this.onLog(`远端用户已入会，但尚未验证到视频帧: ${error.message}`, 'warn');
    } finally {
      this.verifyingUsers.delete(userId);
    }
  }

  async _waitForDecodedFrames(userId, version) {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline && version === this.verifyVersion) {
      const videos = [...this.videoEl.parentElement.querySelectorAll('video')];
      const video = videos.find((item) => item.videoWidth > 0 && item.videoHeight > 0 && item.readyState >= 2);
      if (video) {
        const startedAt = performance.now();
        const initialTime = Number(video.currentTime || 0);
        const frames = await countRenderedFrames(video, 3, 4_000);
        const currentTimeDelta = Number(video.currentTime || 0) - initialTime;
        if (frames >= 2 || currentTimeDelta > 0.08) {
          return {
            provider: this.provider,
            userId,
            width: video.videoWidth,
            height: video.videoHeight,
            frames: Math.max(frames, 2),
            sampleMs: Math.round(performance.now() - startedAt),
          };
        }
      }
      await sleep(250);
    }
    throw new Error('20 秒内没有收到可连续渲染的远端视频帧');
  }

  async _readRemoteStats(userId) {
    const owner = this.client || this.engine;
    const method = owner && ['getRemoteVideoStats', 'getRemoteVideoStatistics'].find((name) => typeof owner[name] === 'function');
    if (!method) return '';
    try {
      const raw = await owner[method]();
      const values = collectPositiveMediaMetrics(raw, userId);
      return values.slice(0, 4).join('，');
    } catch {
      return '';
    }
  }

  // ───────────────── 离会 ─────────────────

  /**
   * 离会。注意两点，都是踩过的坑：
   *   - AliRtcEngine 是单例，destroy() 必须放在 finally 里。只在成功分支 destroy，
   *     一旦 leaveChannel 抛错，单例就残留，下一次 getInstance() 拿到脏实例，第二通电话必失败。
   *   - 必须清 srcObject，否则最后一帧会一直冻在画面上，看起来像还在通话。
   */
  async leave() {
    this.targetUserId = '';
    this.verifyVersion++;
    this.verifyingUsers.clear();
    try {
      if (this.provider === 'trtc' && this.client) {
        await this.client.exitRoom();
      } else if (this.provider === 'agora' && this.client) {
        await this.client.leave();
      } else if (this.engine) {
        await this.engine.leaveChannel();
      }
      this.onLog('已离开 RTC 频道');
    } catch (e) {
      this.onLog(`离会异常: ${e.message}`, 'warn');
    } finally {
      if (this.engine && typeof this.engine.destroy === 'function') {
        try { this.engine.destroy(); } catch { /* 忽略 */ }
      }
      this.engine = this.client = null;
      this.remoteStreams.clear();
      this.audioUsers.clear();
      this.activeVideo = null;
      this.videoEl.srcObject = null;
      this.videoEl.style.display = ''; // TRTC 分支曾隐藏它
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countRenderedFrames(video, target, timeoutMs) {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return sleep(Math.min(timeoutMs, 1_200)).then(() => Number(video.currentTime || 0) > 0 ? target : 0);
  }
  return new Promise((resolve) => {
    let frames = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(frames);
    };
    const timer = setTimeout(finish, timeoutMs);
    const next = () => {
      if (settled) return;
      frames++;
      if (frames >= target) {
        clearTimeout(timer);
        finish();
      } else {
        video.requestVideoFrameCallback(next);
      }
    };
    video.requestVideoFrameCallback(next);
  });
}

export function collectPositiveMediaMetrics(value, userId = '', path = '') {
  const results = [];
  const visit = (item, currentPath, depth) => {
    if (depth > 5 || item == null) return;
    if (typeof item === 'number' && item > 0 && /(byte|bitrate|frame|decode|receive|packet)/i.test(currentPath)) {
      results.push(`${currentPath.split('.').at(-1)}=${Math.round(item)}`);
      return;
    }
    if (item instanceof Map) {
      if (userId && item.has(userId)) visit(item.get(userId), `${currentPath}.${userId}`, depth + 1);
      else for (const [key, child] of item.entries()) visit(child, `${currentPath}.${String(key)}`, depth + 1);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${currentPath}.${index}`, depth + 1));
      return;
    }
    if (typeof item === 'object') {
      const entries = Object.entries(item);
      const matched = userId ? entries.find(([key]) => key === userId) : null;
      if (matched) visit(matched[1], `${currentPath}.${matched[0]}`, depth + 1);
      else entries.forEach(([key, child]) => visit(child, `${currentPath}.${key}`, depth + 1));
    }
  };
  visit(value, path || 'stats', 0);
  return [...new Set(results)];
}
