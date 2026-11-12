export function abortableDelay(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class MonetDirector {
  constructor(options) {
    this.options = options;
    this.active = false;
    this.opened = false;
    this.closed = false;
    this.busy = false;
    this.controller = null;
    this.idleTimer = null;
    this.queue = Promise.resolve();
    this.entries = [];
    this.version = 0;
  }

  note(event, details = {}) {
    const entry = { at: new Date().toISOString(), event, ...details };
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.shift();
    this.options.onEvent?.(entry);
  }

  clearIdle() {
    (this.options.clearTimer || clearTimeout)(this.idleTimer);
    this.idleTimer = null;
  }

  armIdle() {
    this.clearIdle();
    if (!this.active || this.closed || this.busy || !this.options.idleMs) return;
    this.idleTimer = (this.options.setTimer || setTimeout)(() => {
      this.run({ event: 'closing' }).catch(error => this.options.onError?.(error));
    }, this.options.idleMs);
  }

  start() {
    if (this.opened) return this.queue;
    this.active = true;
    this.opened = true;
    this.closed = false;
    this.entries = [];
    return this.run({ event: 'opening' });
  }

  cancel() {
    this.clearIdle();
    this.version++;
    this.controller?.abort();
    this.controller = null;
    this.options.interrupt?.();
    this.busy = false;
    this.options.onState?.(this);
  }

  stop() {
    this.active = false;
    this.cancel();
    this.note('stopped');
  }

  run(input) {
    if (!this.active) return Promise.resolve();
    if (input.event === 'closing' && this.closed) return this.queue;
    this.cancel();
    const version = this.version;
    const controller = new AbortController();
    this.controller = controller;
    this.busy = true;
    this.options.onState?.(this);
    this.queue = this.queue.catch(() => {}).then(async () => {
      controller.signal.throwIfAborted();
      if (input.event === 'demo') {
        this.closed = false;
        for (const step of [
          { event: 'opening' },
          { event: 'turn', text: '请帮我更换一个宏大的幻想背景场景' },
          { event: 'turn', text: '我想放很多图片和素材' },
          { event: 'turn', text: '请跳一小段舞' },
          { event: 'turn', text: '今天过得怎么样？' },
          { event: 'closing' },
        ]) await this.step(step, controller.signal);
      } else if (input.event === 'matrix') {
        this.closed = false;
        const available = this.options.availableRequirements?.() || [];
        const actions = this.options.actions || [];
        for (const [index, action] of actions.entries()) {
          controller.signal.throwIfAborted();
          const missing = (action.requires || []).filter(requirement => !available.includes(requirement));
          if (missing.length) {
            this.note('skipped', { action_id: action.id, name: action.name, reason: `缺少已确认条件：${missing.join('、')}`, index: index + 1, total: actions.length });
            continue;
          }
          this.note('progress', { action_id: action.id, name: action.name, index: index + 1, total: actions.length });
          await this.step({ event: 'action', action_id: action.id }, controller.signal);
        }
      } else {
        if (input.event === 'opening' || input.event === 'turn') this.closed = false;
        await this.step(input, controller.signal);
      }
    }).catch(error => {
      this.note(controller.signal.aborted ? 'cancelled' : 'failed', { message: controller.signal.aborted ? '任务已打断' : error.message });
      if (!controller.signal.aborted) throw error;
    }).finally(() => {
      if (version !== this.version) return;
      this.controller = null;
      this.busy = false;
      this.options.onState?.(this);
      this.armIdle();
    });
    return this.queue;
  }

  async step(input, signal) {
    signal.throwIfAborted();
    const result = await this.options.prepare(input, signal);
    signal.throwIfAborted();
    const missing = (result.action?.requires || []).filter(requirement => !(this.options.availableRequirements?.() || []).includes(requirement));
    if (missing.length) throw new Error(`动作需先确认素材条件：${missing.join('、')}`);
    this.note('prepared', { intent: result.intent, action_id: result.action?.id, text: result.text });
    await this.options.perform(result, signal);
    signal.throwIfAborted();
    if (result.intent === 'closing') this.closed = true;
    this.note('submitted', { intent: result.intent, action_id: result.action?.id, visual_verdict: 'pending_review' });
    if (result.intent === 'scene') {
      const proof = await this.options.changeScene(signal);
      signal.throwIfAborted();
      this.note('editing_frames_received', { ...proof, visual_verdict: 'pending_review' });
      await this.step({ event: 'scene_ready' }, signal);
    }
  }

  report() {
    return {
      task: 'monet-infinite-canvas',
      generated_at: new Date().toISOString(),
      automatic_checks: '调度、发送与视频帧接收；不自动判断动作语义、自然度或口型质量',
      visual_verdict: 'pending_review',
      entries: this.entries.slice(),
    };
  }
}
