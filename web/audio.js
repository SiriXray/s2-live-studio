export const FRAME_BYTES = 960;
/** 文档允许的 100ms 稳定帧：TTS 口播用 100ms 一批，减少 20ms 定时器抖动造成的“颤音/卡顿” */
export const STABLE_FRAME_BYTES = 4800;

export function decodePcm(base64) {
  if (typeof base64 !== 'string' || !base64) throw new Error('音频为空');
  const binary = atob(base64);
  if (binary.length % 2) throw new Error('PCM16音频长度不合法');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** signal 可选：中控台/礼物播报（speakOut）不带 abort 信号也能正常推流。
 * leadMs 是预缓冲：先提前发送一小段音频，吸收浏览器 setTimeout/渲染抖动，避免 S2 句中欠载卡顿。
 * 只给完整 TTS 句使用；唱歌/舞蹈保持 0，避免破坏音画同步。
 */
export async function sendPcm(stream, bytes, signal, clock = () => performance.now(), wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), frameBytes = FRAME_BYTES, leadMs = 0) {
  if (!bytes.length || bytes.length % 2) throw new Error('PCM16音频长度不合法');
  const start = clock();
  const lead = Math.max(0, Number(leadMs) || 0);
  let timelineStart = start;
  for (let offset = 0; offset < bytes.length; offset += frameBytes) {
    signal?.throwIfAborted();
    const due = timelineStart + offset / 48 - lead;
    const delay = due - clock();
    if (delay > 0) await wait(delay);
    signal?.throwIfAborted();
    /* 长时间本地音频/后台标签页会让页面调度偶尔落后；不直接中断，重新对齐时间轴。 */
    if (clock() - due > 500) timelineStart = clock() - offset / 48 + lead;
    /* WebSocket 发送缓冲积压：等待网络排空，不中断整段音频。 */
    const bufferStarted = clock();
    while ((stream.ws?.bufferedAmount || 0) > 96000) {
      if (clock() - bufferStarted > 10000) throw new Error('网络音频积压超时，请检查上行网络后重试');
      await wait(20);
    }
    const frame = new Uint8Array(frameBytes);
    frame.set(bytes.subarray(offset, offset + frameBytes));
    if (!stream.sendAudio(frame)) throw new Error('音频通道已断开');
  }
  await wait(20 + lead + (lead > 0 ? frameBytes / 48 : 0));
  signal?.throwIfAborted();
}

export function pcmWav(bytes) {
  const buffer = new ArrayBuffer(44 + bytes.byteLength);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + bytes.length, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, bytes.length, true); new Uint8Array(buffer, 44).set(bytes);
  return new Blob([buffer], { type: 'audio/wav' });
}
