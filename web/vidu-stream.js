/**
 * Vidu 外接直播 WebSocket 协议客户端。
 *
 * 协议要点（来自官方文档）：
 *   - 文本帧 = JSON WsSignal，二进制帧 = 裸 PCM
 *   - 首帧必须是 conn_init(1)，收到 conn_init_ack(2).success=true 才算就绪
 *   - NOT_READY 是正常现象：重发 conn_init 即可，不要重连 WS
 *   - 数字人要动，三样缺一不可：PCM 音频 + input_transcription(9) + output_transcription(10)
 *
 * 本文件不碰任何密钥：鉴权由本地服务在代理 WS 时注入。
 */

export const SIG = {
  CONN_INIT: 1,
  CONN_INIT_ACK: 2,
  CALL_HANGUP: 5,
  FORCE_HANGUP: 6,
  AUDIO_INTERRUPTED: 7,
  INPUT_TRANSCRIPTION: 9,
  OUTPUT_TRANSCRIPTION: 10,
  TEXT_MSG: 99,
  TEXT_TTS: 100,
  TEXT_ACTION: 101,
  TEXT_DIALOG: 102,
  SWITCH_AVATAR: 16,
  ERROR: 103,
};

export class ViduStream {
  /**
   * @param {object} opts
   * @param {string} opts.liveId
   * @param {string} [opts.clientSecret] 创建外接直播返回的短期 WebSocket 凭据
   * @param {string} [opts.connId]
   * @param {(msg:string, level?:string)=>void} [opts.onLog]
   * @param {(sig:object)=>void} [opts.onSignal]
   * @param {(reason:string)=>void} [opts.onHangup]
   * @param {()=>void} [opts.onReady]
   * @param {boolean} [opts.keepAlive] 空闲时补静音帧维持心跳，默认 true
   */
  constructor(opts) {
    this.liveId = String(opts.liveId);
    this.clientSecret = String(opts.clientSecret || '').trim();
    this.connId = opts.connId || `qs-${Date.now().toString(36)}`;
    this.onLog = opts.onLog || (() => {});
    this.onSignal = opts.onSignal || (() => {});
    this.onSwitchAvatarError = opts.onSwitchAvatarError || (() => {});
    this.onHangup = opts.onHangup || (() => {});
    this.onReady = opts.onReady || (() => {});
    this.keepAliveEnabled = opts.keepAlive !== false;
    // NOT_READY 最多重试 40 次 × 1s，留些余量
    this.initTimeoutMs = opts.initTimeoutMs || 60000;
    this.maxSignalBytes = opts.maxSignalBytes || 64 * 1024;

    this.ws = null;
    this.seq = 0;
    this.ready = false;
    this.closed = false;
    this.lastSendAt = 0;
    this._initTimer = null;
    this._keepAliveTimer = null;
    this._initAttempts = 0;
  }

  /** 经本地服务代理建连（服务端注入 Authorization） */
  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/live?live_id=${encodeURIComponent(this.liveId)}` +
      `&conn_id=${encodeURIComponent(this.connId)}` +
      (this.clientSecret ? `&client_secret=${encodeURIComponent(this.clientSecret)}` : '');

    return new Promise((resolve, reject) => {
      let settled = false;
      // 兜底超时：WS 连上但 conn_init_ack 一直不来（既不成功也不报错）时，
      // 不能让调用方永远挂着，否则页面就卡在「WS 连接中」看不出原因。
      const initTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.onLog(`conn_init 超时：${this.initTimeoutMs / 1000}s 内没收到 conn_init_ack`, 'err');
        try { if (this.ws) this.ws.close(); } catch { /* 忽略 */ }
        reject(new Error('conn_init 超时，未收到 conn_init_ack'));
      }, this.initTimeoutMs);
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimeout);
        fn(arg);
      };

      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.onLog('WebSocket 已连接，发送 conn_init…');
        this._sendConnInit();
      };

      this.ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return; // 上行为主，服务端极少下发二进制
        let sig;
        try {
          sig = JSON.parse(ev.data);
        } catch {
          this.onLog(`收到无法解析的文本帧: ${String(ev.data).slice(0, 120)}`, 'warn');
          return;
        }
        this.onSignal(sig);

        if (sig.type === SIG.CONN_INIT_ACK) {
          const ack = (sig.payload && sig.payload.conn_init_ack) || {};
          if (ack.success) {
            this.ready = true;
            this._initAttempts = 0;
            clearTimeout(this._initTimer);
            this.onLog('conn_init_ack.success=true，渲染侧就绪', 'ok');
            this._startKeepAlive();
            this.onReady();
            settle(resolve);
          } else {
            const code = ack.error_code || '(无 error_code)';
            if (code === 'NOT_READY') {
              // 文档明确：重试 conn_init，不要重连 WS
              this._initAttempts++;
              if (this._initAttempts > 40) {
                this.onLog('NOT_READY 重试超过 40 次，放弃', 'err');
                settle(reject, new Error('渲染服务长时间未就绪'));
                return;
              }
              this.onLog(`NOT_READY（第 ${this._initAttempts} 次），1s 后重发 conn_init`);
              this._initTimer = setTimeout(() => this._sendConnInit(), 1000);
            } else {
              this.onLog(`conn_init 失败: ${code} ${ack.error_msg || ''}`, 'err');
              settle(reject, new Error(`conn_init 失败: ${code} ${ack.error_msg || ''}`.trim()));
            }
          }
          return;
        }

        if (sig.type === SIG.ERROR) {
          const error = (sig.payload && sig.payload.error) || {};
          this.onLog(`服务端错误信令(103): source=${error.source || '?'} code=${error.error_code || '?'} ${error.error_msg || ''}`, 'err');
          // switch_avatar 无成功回执，只有失败才下发 103；这里交给上层展示
          if (error.source === 'switch_avatar') this.onSwitchAvatarError(error);
          return;
        }

        if (sig.type === SIG.FORCE_HANGUP) {
          const reason = (sig.payload && sig.payload.hangup && sig.payload.hangup.hangup_reason) || 'unknown';
          this.onLog(`服务端强制挂断: ${reason}`, 'err');
          this.onHangup(reason);
        }
      };

      this.ws.onerror = () => {
        this.onLog('WebSocket 出错', 'err');
        settle(reject, new Error('WebSocket 出错（建连被拒或网络异常）'));
      };

      this.ws.onclose = (ev) => {
        this._stopKeepAlive();
        clearTimeout(this._initTimer);
        this.ready = false;
        if (!this.closed) {
          this.onLog(`WebSocket 已关闭 code=${ev.code} ${ev.reason || ''}`, 'warn');
          this.onHangup(`ws_close_${ev.code}`);
        }
        settle(reject, new Error(`WebSocket 关闭 code=${ev.code}`));
      };
    });
  }

  _sendConnInit() {
    this._sendSignal(SIG.CONN_INIT, { conn_init: { version: 1 } });
  }

  _sendSignal(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const sig = {
      type,
      live_id: this.liveId,
      conn_id: this.connId,
      seq_id: ++this.seq,
      payload: payload || {},
    };
    const text = JSON.stringify(sig);
    if (new TextEncoder().encode(text).length > this.maxSignalBytes) {
      this.onLog('文本帧超过协议大小限制，已丢弃', 'err');
      return false;
    }
    this.ws.send(text);
    this.lastSendAt = Date.now();
    return true;
  }

  /** 用户说的话（你的 ASR 结果） */
  sendInputText(content, msgId) {
    if (!content) return false;
    return this._sendSignal(SIG.INPUT_TRANSCRIPTION, {
      text_msg: { msg_id: msgId || `in-${this.seq + 1}`, content, timestamp: Date.now() },
    });
  }

  /** 模型回复的话（你的 LLM 结果） */
  sendOutputText(content, msgId) {
    if (!content) return false;
    return this._sendSignal(SIG.OUTPUT_TRANSCRIPTION, {
      text_msg: { msg_id: msgId || `out-${this.seq + 1}`, content, timestamp: Date.now() },
    });
  }

  /** 打断数字人当前回复。建议在 VAD 检测到用户开口时调用 */
  interrupt() {
    return this._sendSignal(SIG.AUDIO_INTERRUPTED, {});
  }

  switchPrompt(image, editingType) {
    if (!this.ready || !['virtual_tryon', 'style_transfer', 'subject_replacement', 'background_replacement'].includes(editingType)) return false;
    return this._sendSignal(13, { switch_prompt: { prompts: [{ type: 'image', content: image }], editing_type: editingType } });
  }

  baselineReset() {
    return this.ready && this._sendSignal(15, {});
  }

  /**
   * type=16 switch_avatar：播放转场视频后切换形象。
   * - videos: 1~10 个 http(s) 视频地址，按顺序完整播放一轮后新形象生效（可拿来当离线 MV 播放器）
   * - avatarId: 资产库形象 ID（字符串，非图片地址）；切回原形象时再次调用
   * 注意：成功不回执，失败才发 type=103（error.source=switch_avatar），勿用「没回执就重发」策略。
   */
  switchAvatar(videos, avatarId) {
    if (!this.ready) return false;
    if (!Array.isArray(videos) || videos.length < 1 || videos.length > 10) return false;
    if (videos.some(url => !/^https:\/\//.test(String(url)))) return false;
    const payload = { switch_avatar: { switch_videos: videos.slice(0, 10).map(String) } };
    if (avatarId) payload.switch_avatar.avatar_id = String(avatarId);
    return this._sendSignal(SIG.SWITCH_AVATAR, payload);
  }

  /**
   * 动作通道：
   * - component（默认）：type 9 input_transcription，内容「请做+动作名」，由动作库匹配；
   * - realtime：type 101 text_action，动作与对话/口播分离，不会被用户原话误触发。
   * 实时版 type 9/10 是转写事件，不是上行动作命令，勿混用。
   */
  sendAction(name, options = {}) {
    if (!this.ready || typeof name !== 'string' || !name.trim() || name.length > 20) return false;
    if (options.protocol === 'realtime') {
      return this._sendSignal(SIG.TEXT_ACTION, {
        text_action: { msg_id: `action-${this.seq + 1}`, content: name.trim() },
      });
    }
    return this.sendInputText(`请做${name.trim()}`, `action-${this.seq + 1}`);
  }

  /** 实时版：纯对话文本（不触发动作），适合精确控制动作时使用 */
  sendDialog(content, msgId) {
    if (!content || typeof content !== 'string') return false;
    return this._sendSignal(SIG.TEXT_DIALOG, {
      text_dialog: { msg_id: msgId || `dialog-${this.seq + 1}`, content },
    });
  }

  /** 实时版：指定文本直接 TTS 播出，不进入对话上下文、不触发动作 */
  sendDirectTts(content, msgId) {
    if (!content || typeof content !== 'string') return false;
    return this._sendSignal(SIG.TEXT_TTS, {
      text_tts: { msg_id: msgId || `tts-${this.seq + 1}`, content },
    });
  }

  /** 实时版：普通文本消息（可能触发回复/动作，脚本演出慎用） */
  sendTextMessage(content, msgId) {
    if (!content || typeof content !== 'string') return false;
    return this._sendSignal(SIG.TEXT_MSG, {
      text_msg: { msg_id: msgId || `msg-${this.seq + 1}`, content },
    });
  }

  hangup(reason) {
    return this._sendSignal(SIG.CALL_HANGUP, { hangup: { hangup_reason: reason || 'client_hangup' } });
  }

  /**
   * 上行 PCM。要求 s16le / 24000Hz / 单声道，48 字节每毫秒。
   * 单帧上限 64 KiB，超了自动切分。
   */
  sendAudio(buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return false;
    const MAX = 64 * 1024;
    const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let off = 0; off < u8.length; off += MAX) {
      this.ws.send(u8.subarray(off, Math.min(off + MAX, u8.length)));
    }
    this.lastSendAt = Date.now();
    return true;
  }

  /**
   * 文档提示约 15s 无消息会被判死连接。浏览器会自动回 pong，
   * 这里再补一层：空闲超过 3s 就发 20ms 静音（960 字节），成本可忽略。
   */
  _startKeepAlive() {
    if (!this.keepAliveEnabled || this._keepAliveTimer) return;
    const silence = new Uint8Array(960); // 20ms @ 24kHz s16le mono
    this._keepAliveTimer = setInterval(() => {
      if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSendAt >= 3000) this.sendAudio(silence);
    }, 1000);
  }

  _stopKeepAlive() {
    clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }

  close(reason) {
    this.closed = true;
    this._stopKeepAlive();
    clearTimeout(this._initTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.hangup(reason || 'client_hangup');
      setTimeout(() => this.ws && this.ws.close(), 120);
    } else if (this.ws) {
      this.ws.close();
    }
    this.ready = false;
  }
}
