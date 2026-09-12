import { encodeDevToolsMessage } from './devtools-wire.js';

const BACKPRESSURE_TIMEOUT_MS = 15_000;
const MAX_OUTBOUND_BYTES = 64 * 1024 * 1024;
const OUTBOUND_WINDOW = 8;

export const clearDevToolsOutbound = (state) => {
  for (const item of state.outbound.values()) clearTimeout(item.timer);
  state.outbound.clear();
  state.outboundBytes = 0;
};

export const acknowledgeDevToolsMessage = (state, ack) => {
  const item = state.outbound.get(ack.messageId);
  if (!item || ack.index >= item.next || ack.index <= item.acked) return false;
  item.acked = ack.index;
  item.progressAt = Date.now();
  clearTimeout(item.timer);
  item.timer = null;
  if (item.acked === item.chunks.length - 1) {
    state.outbound.delete(item.messageId);
    state.outboundBytes -= item.bytes;
  }
  return true;
};

export const createDevToolsOutbound = ({ isCurrent, closeWith, sendJson }) => {
  const pump = (state) => {
    if (!isCurrent(state)) { closeWith(state, 'DEVTOOLS_CONTROL_LOST'); return; }
    let active = 0;
    for (const item of state.outbound.values()) {
      if (item.next > 0) active += 1;
      else if (active < 2) active += 1;
      else continue;
      while (item.next < item.chunks.length && item.next <= item.acked + OUTBOUND_WINDOW) {
        if (item.next === 0) item.progressAt = Date.now();
        sendJson(state.viewer.socket, {
          type: 'devtoolsMessageChunk', devtoolsId: state.devtoolsId, messageId: item.messageId,
          ...item.chunks[item.next],
        });
        item.next += 1;
      }
      if (item.next > item.acked + 1 && !item.timer) {
        item.timer = setTimeout(() => closeWith(state, 'DEVTOOLS_BACKPRESSURE', 'ack-timeout'), BACKPRESSURE_TIMEOUT_MS);
        item.timer.unref?.();
      }
    }
    if (state.outbound.size >= 2) state.inbound?.pause();
    else state.inbound?.resume();
  };

  const queue = (state, raw) => {
    let chunks;
    try { chunks = encodeDevToolsMessage(raw); } catch { closeWith(state, 'DEVTOOLS_MESSAGE_TOO_LARGE'); return; }
    const bytes = chunks[0].byteLength;
    if (state.outbound.size >= 256) {
      closeWith(state, 'DEVTOOLS_BACKPRESSURE', 'queue-count'); return;
    }
    if (state.outboundBytes + state.inboundBytes + bytes > MAX_OUTBOUND_BYTES) {
      closeWith(state, 'DEVTOOLS_BACKPRESSURE', 'queue-bytes'); return;
    }
    const messageId = String(++state.nextMessageId);
    state.outboundBytes += bytes;
    state.outbound.set(messageId, { messageId, chunks, next: 0, acked: -1, timer: null, bytes, progressAt: Date.now() });
    pump(state);
  };

  const diagnostics = (state) => {
    let inFlightMessages = 0;
    let unackedChunks = 0;
    let oldestAckAgeMs = 0;
    for (const item of state.outbound.values()) {
      if (item.next <= item.acked + 1) continue;
      inFlightMessages++;
      unackedChunks += item.next - item.acked - 1;
      oldestAckAgeMs = Math.max(oldestAckAgeMs, Date.now() - item.progressAt);
    }
    return { queueCount: state.outbound.size, queueBytes: state.outboundBytes,
      inFlightMessages, unackedChunks, oldestAckAgeMs,
      queuedCdpMessages: state.inbound?.readableLength ?? 0,
      queuedCdpBytes: state.inboundBytes,
      viewerBufferedBytes: state.viewer.socket.bufferedAmount ?? 0,
      cdpBufferedBytes: state.socket?.bufferedAmount ?? 0 };
  };

  return { pump, queue, diagnostics };
};
