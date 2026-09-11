// Downstream credit belongs to the end client, not the relay's TCP connection.
// Producers await send(), so HTTP readers stop before building a plaintext queue.
import { decodeTunnelFrame } from './tunnel-codec.js';
import { MAX_PLAINTEXT_FRAME_BYTES } from './e2ee.js';

export const DOWNSTREAM_CHUNK_BYTES = 8 * 1024;
const MIN_WINDOW_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 1024 * 1024;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 4096;
const MAX_OUTSTANDING_FRAMES = 4096;
const QUEUE_DELAY_TARGET_MS = 100;

export const createDownstreamScheduler = ({ sendBatch, onError, maxBatchFrames = 32, now = () => performance.now() }) => {
  const queues = new Map();
  const outstanding = [];
  let queuedBytes = 0;
  let queuedFrames = 0;
  let sentBytes = 0;
  let acknowledgedBytes = 0;
  let windowBytes = MIN_WINDOW_BYTES;
  let minRtt = Infinity;
  let adjustmentBoundary = MIN_WINDOW_BYTES;
  let windowLimited = false;
  let draining = false;
  let closed = false;
  let sending = [];

  const close = () => {
    closed = true;
    for (const queue of queues.values()) for (const entry of queue) entry.resolve();
    for (const entry of sending) entry.resolve();
    sending = [];
    queues.clear();
    outstanding.length = 0;
    queuedBytes = 0;
    queuedFrames = 0;
  };

  const fail = error => {
    close();
    onError(error);
  };

  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    try {
      while (!closed) {
        const selected = [];
        let batchBytes = 1;
        while (selected.length < maxBatchFrames) {
          // Stream zero carries only tiny keepalives; it must not wait for credit.
          const next = queues.has(0) ? [0, queues.get(0)] : queues.entries().next().value;
          if (!next) break;
          const [streamId, queue] = next;
          const entry = queue[0];
          // Do not skip a larger head indefinitely in favour of smaller frames.
          if (streamId !== 0 && sentBytes - acknowledgedBytes + entry.frame.length > windowBytes) {
            windowLimited = true;
            break;
          }
          if (streamId !== 0 && outstanding.length >= MAX_OUTSTANDING_FRAMES) break;
          if (batchBytes + 4 + entry.frame.length > MAX_PLAINTEXT_FRAME_BYTES) break;
          queue.shift();
          queues.delete(streamId);
          if (queue.length) queues.set(streamId, queue);
          queuedBytes -= entry.frame.length;
          queuedFrames -= 1;
          if (streamId !== 0) {
            sentBytes += entry.frame.length;
            outstanding.push({ end: sentBytes, at: now() });
          }
          selected.push(entry);
          batchBytes += 4 + entry.frame.length;
        }
        if (!selected.length) break;
        sending = selected;
        try {
          // Selection precedes encryption. Never reorder encrypted IV counters.
          await sendBatch(selected.map(entry => entry.frame));
        } finally {
          for (const entry of selected) entry.resolve();
          sending = [];
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      draining = false;
    }
  };

  return {
    send(frame) {
      if (closed) return Promise.resolve();
      const { streamId } = decodeTunnelFrame(frame);
      if (queuedBytes + frame.length > MAX_QUEUED_BYTES || queuedFrames >= MAX_QUEUED_FRAMES) {
        fail(new Error('relay downstream queue limit exceeded'));
        return Promise.resolve();
      }
      return new Promise(resolve => {
        const queue = queues.get(streamId) ?? [];
        queue.push({ frame, resolve, streamId });
        queues.set(streamId, queue);
        queuedBytes += frame.length;
        queuedFrames += 1;
        // Let concurrent streams join this round before selecting the next frame.
        queueMicrotask(() => { void drain(); });
      });
    },
    acknowledge(bytes) {
      if (closed) return;
      if (!Number.isSafeInteger(bytes) || bytes <= acknowledgedBytes || bytes > sentBytes) {
        throw new Error('invalid relay delivery acknowledgement');
      }
      // An ACK may cover several complete frames, never a partial frame.
      const endIndex = outstanding.findIndex(entry => entry.end === bytes);
      if (endIndex < 0) throw new Error('relay acknowledgement is not a frame boundary');
      const rtt = Math.max(1, now() - outstanding[endIndex].at);
      outstanding.splice(0, endIndex + 1);
      acknowledgedBytes = bytes;
      minRtt = Math.min(minRtt, rtt);
      // Grow on a clear path, reduce when the client's delivery delay grows.
      // Adjust once per window, not once per frame in a burst of ACKs.
      if (bytes >= adjustmentBoundary) {
        if (rtt > minRtt + QUEUE_DELAY_TARGET_MS) {
          windowBytes = Math.max(MIN_WINDOW_BYTES, Math.floor(windowBytes / 2));
        } else if (windowLimited) {
          // Sparse token traffic must not inflate a future bash burst's window.
          windowBytes = Math.min(MAX_WINDOW_BYTES, windowBytes * 2);
        }
        windowLimited = false;
        adjustmentBoundary = bytes + windowBytes;
      }
      void drain();
    },
    cancel(streamId) {
      // Already-selected bytes may still arrive and must still be ACKed, but
      // cancelled producers need not wait for an in-progress encryption call.
      for (const entry of sending) if (entry.streamId === streamId) entry.resolve();
      const queue = queues.get(streamId);
      if (!queue) return;
      queues.delete(streamId);
      for (const entry of queue) {
        queuedBytes -= entry.frame.length;
        queuedFrames -= 1;
        entry.resolve();
      }
      void drain();
    },
    close,
  };
};
