import { decodeTunnelFrame } from './tunnel-codec.js';
import { MAX_PLAINTEXT_FRAME_BYTES } from './e2ee.js';

export const DOWNSTREAM_CHUNK_BYTES = 8 * 1024;
const MIN_WINDOW_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 1024 * 1024;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 4096;
const MAX_OUTSTANDING_FRAMES = 4096;
const QUEUE_DELAY_TARGET_MS = 100;

interface QueuedFrame<BufferType extends ArrayBufferLike> { frame: Uint8Array<BufferType>; resolve: () => void; streamId: number }
interface DownstreamSchedulerOptions<BufferType extends ArrayBufferLike> {
  sendBatch: (frames: Uint8Array<BufferType>[]) => Promise<void>;
  onError: (cause: unknown) => void;
  maxBatchFrames?: number;
  now?: () => number;
}
export const createDownstreamScheduler = <BufferType extends ArrayBufferLike = ArrayBufferLike>({ sendBatch, onError, maxBatchFrames = 32, now = () => performance.now() }: DownstreamSchedulerOptions<BufferType>) => {
  const queues = new Map<number, QueuedFrame<BufferType>[]>();
  const outstanding: { end: number; at: number }[] = [];
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
  let sending: QueuedFrame<BufferType>[] = [];

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

  const fail = (cause: unknown) => {
    close();
    onError(cause);
  };

  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    try {
      while (!closed) {
        const selected: QueuedFrame<BufferType>[] = [];
        let batchBytes = 1;
        while (selected.length < maxBatchFrames) {
          const priority = queues.get(0);
          const next: [number, QueuedFrame<BufferType>[]] | undefined = priority ? [0, priority] : queues.entries().next().value;
          if (!next) break;
          const [streamId, queue] = next;
          const entry = queue[0];
          if (!entry) throw new Error('relay downstream queue is empty');
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
    send(frame: Uint8Array<BufferType>) {
      if (closed) return Promise.resolve();
      const { streamId } = decodeTunnelFrame(frame);
      if (queuedBytes + frame.length > MAX_QUEUED_BYTES || queuedFrames >= MAX_QUEUED_FRAMES) {
        fail(new Error('relay downstream queue limit exceeded'));
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        const queue = queues.get(streamId) ?? [];
        queue.push({ frame, resolve, streamId });
        queues.set(streamId, queue);
        queuedBytes += frame.length;
        queuedFrames += 1;
        queueMicrotask(() => { void drain(); });
      });
    },
    acknowledge(bytes: number) {
      if (closed) return;
      if (!Number.isSafeInteger(bytes) || bytes <= acknowledgedBytes || bytes > sentBytes) {
        throw new Error('invalid relay delivery acknowledgement');
      }
      const endIndex = outstanding.findIndex(entry => entry.end === bytes);
      if (endIndex < 0) throw new Error('relay acknowledgement is not a frame boundary');
      const acknowledged = outstanding[endIndex];
      if (!acknowledged) throw new Error('relay acknowledgement is not a frame boundary');
      const rtt = Math.max(1, now() - acknowledged.at);
      outstanding.splice(0, endIndex + 1);
      acknowledgedBytes = bytes;
      minRtt = Math.min(minRtt, rtt);
      if (bytes >= adjustmentBoundary) {
        if (rtt > minRtt + QUEUE_DELAY_TARGET_MS) {
          windowBytes = Math.max(MIN_WINDOW_BYTES, Math.floor(windowBytes / 2));
        } else if (windowLimited) {
          windowBytes = Math.min(MAX_WINDOW_BYTES, windowBytes * 2);
        }
        windowLimited = false;
        adjustmentBoundary = bytes + windowBytes;
      }
      void drain();
    },
    cancel(streamId: number) {
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
