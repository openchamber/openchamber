// Tunnel mux frame codec (Layer 3 of the protocol spec). Pure functions, no I/O.
// Frame layout: [1 byte frameType (high bit = fragment-continues)][4 byte BE streamId][payload].
// Client-initiated streams use odd streamIds starting at 1; even ids are reserved.
// Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 3).

import {
  BATCH_CONTAINER_TAG_BATCH,
  BATCH_CONTAINER_TAG_SINGLE,
  BATCH_FRAME_LENGTH_BYTES,
  MAX_PLAINTEXT_FRAME_BYTES,
  MAX_TUNNEL_PAYLOAD_BYTES,
  TUNNEL_FRAGMENT_FLAG,
  TUNNEL_FRAME_HEADER_BYTES,
  TunnelFrameType,
  isTunnelFrameType,
  type TunnelFrameTypeValue,
} from './protocol';

const MAX_STREAM_ID = 0xffffffff;

export class TunnelCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelCodecError';
  }
}

export interface TunnelFrame {
  frameType: TunnelFrameTypeValue;
  streamId: number;
  payload: Uint8Array;
  /** True when this frame is a fragment and more fragments of the same message follow. */
  hasMoreFragments: boolean;
}

export const encodeTunnelFrame = (
  frameType: TunnelFrameTypeValue,
  streamId: number,
  payload: Uint8Array,
  hasMoreFragments = false,
): Uint8Array => {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID) {
    throw new TunnelCodecError('invalid stream id');
  }
  if (payload.length > MAX_TUNNEL_PAYLOAD_BYTES) {
    throw new TunnelCodecError('tunnel payload exceeds maximum size');
  }
  const frame = new Uint8Array(TUNNEL_FRAME_HEADER_BYTES + payload.length);
  frame[0] = hasMoreFragments ? frameType | TUNNEL_FRAGMENT_FLAG : frameType;
  frame[1] = (streamId >>> 24) & 0xff;
  frame[2] = (streamId >>> 16) & 0xff;
  frame[3] = (streamId >>> 8) & 0xff;
  frame[4] = streamId & 0xff;
  frame.set(payload, TUNNEL_FRAME_HEADER_BYTES);
  return frame;
};

export const decodeTunnelFrame = (frame: Uint8Array): TunnelFrame => {
  if (frame.length < TUNNEL_FRAME_HEADER_BYTES) {
    throw new TunnelCodecError('tunnel frame too short');
  }
  const rawType = frame[0];
  const hasMoreFragments = (rawType & TUNNEL_FRAGMENT_FLAG) !== 0;
  const frameType = rawType & ~TUNNEL_FRAGMENT_FLAG;
  if (!isTunnelFrameType(frameType)) {
    throw new TunnelCodecError(`unknown tunnel frame type ${frameType}`);
  }
  const streamId = ((frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4]) >>> 0;
  return {
    frameType,
    streamId,
    payload: frame.slice(TUNNEL_FRAME_HEADER_BYTES),
    hasMoreFragments,
  };
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const encodeJsonPayload = (value: unknown): Uint8Array => textEncoder.encode(JSON.stringify(value));

export const decodeJsonPayload = <T>(payload: Uint8Array, validate: (parsed: unknown) => parsed is T): T => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(payload));
  } catch {
    throw new TunnelCodecError('malformed JSON tunnel payload');
  }
  if (!validate(parsed)) {
    throw new TunnelCodecError('unexpected JSON tunnel payload shape');
  }
  return parsed;
};

/** Split a body/message into payload-sized chunks. Empty input yields one empty chunk. */
export const chunkPayload = (bytes: Uint8Array, chunkSize = MAX_TUNNEL_PAYLOAD_BYTES): Uint8Array[] => {
  if (chunkSize <= 0 || chunkSize > MAX_TUNNEL_PAYLOAD_BYTES) {
    throw new TunnelCodecError('invalid chunk size');
  }
  if (bytes.length === 0) return [new Uint8Array(0)];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks;
};

/**
 * Encode one logical message as one or more frames, setting the fragment flag
 * on all but the last. Used for WS messages that exceed the frame budget.
 */
export const encodeFragmentedMessage = (
  frameType: TunnelFrameTypeValue,
  streamId: number,
  payload: Uint8Array,
): Uint8Array[] => {
  const chunks = chunkPayload(payload);
  return chunks.map((chunk, index) =>
    encodeTunnelFrame(frameType, streamId, chunk, index < chunks.length - 1),
  );
};

/** Reassembles fragmented messages per (streamId, frameType). Bounded to protect memory. */
export const createFragmentAssembler = (maxMessageBytes = 16 * 1024 * 1024) => {
  const pending = new Map<string, { chunks: Uint8Array[]; totalBytes: number }>();
  return {
    /**
     * Returns the complete message payload once all fragments arrived, or null
     * while more fragments are expected.
     */
    push(frame: TunnelFrame): Uint8Array | null {
      const key = `${frame.streamId}:${frame.frameType}`;
      const entry = pending.get(key);
      if (!frame.hasMoreFragments && !entry) {
        return frame.payload;
      }
      const chunks = entry?.chunks ?? [];
      const totalBytes = (entry?.totalBytes ?? 0) + frame.payload.length;
      if (totalBytes > maxMessageBytes) {
        pending.delete(key);
        throw new TunnelCodecError('fragmented message exceeds maximum size');
      }
      chunks.push(frame.payload);
      if (frame.hasMoreFragments) {
        pending.set(key, { chunks, totalBytes });
        return null;
      }
      pending.delete(key);
      const message = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        message.set(chunk, offset);
        offset += chunk.length;
      }
      return message;
    },
    dropStream(streamId: number): void {
      for (const key of pending.keys()) {
        if (key.startsWith(`${streamId}:`)) pending.delete(key);
      }
    },
  };
};

/**
 * Batch envelope encoder (Layer 2 plaintext container). Only used when both
 * peers negotiated `batch`. One encrypted WS message still equals one
 * encrypt() call — this only changes how many tunnel frames it carries.
 *
 * - 1 frame  -> [0x00][frame bytes]                (single, 1-byte overhead)
 * - N frames -> [0x01]([4B BE length][frame])×N    (batch)
 *
 * Callers must keep the encoded size within MAX_PLAINTEXT_FRAME_BYTES; the
 * outbound batcher flushes before an add would exceed the budget.
 */
export const encodeFrameBatch = (frames: Uint8Array[]): Uint8Array => {
  if (frames.length === 0) {
    throw new TunnelCodecError('cannot encode an empty frame batch');
  }
  if (frames.length === 1) {
    const frame = frames[0];
    const out = new Uint8Array(1 + frame.length);
    out[0] = BATCH_CONTAINER_TAG_SINGLE;
    out.set(frame, 1);
    if (out.length > MAX_PLAINTEXT_FRAME_BYTES) {
      throw new TunnelCodecError('frame batch exceeds maximum plaintext size');
    }
    return out;
  }
  let total = 1;
  for (const frame of frames) total += BATCH_FRAME_LENGTH_BYTES + frame.length;
  if (total > MAX_PLAINTEXT_FRAME_BYTES) {
    throw new TunnelCodecError('frame batch exceeds maximum plaintext size');
  }
  const out = new Uint8Array(total);
  out[0] = BATCH_CONTAINER_TAG_BATCH;
  let offset = 1;
  for (const frame of frames) {
    out[offset] = (frame.length >>> 24) & 0xff;
    out[offset + 1] = (frame.length >>> 16) & 0xff;
    out[offset + 2] = (frame.length >>> 8) & 0xff;
    out[offset + 3] = frame.length & 0xff;
    offset += BATCH_FRAME_LENGTH_BYTES;
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
};

/** Decodes a batch-envelope plaintext into its ordered tunnel frames. */
export const decodeFrameBatch = (plaintext: Uint8Array): Uint8Array[] => {
  if (plaintext.length < 1) {
    throw new TunnelCodecError('empty batch plaintext');
  }
  const tag = plaintext[0];
  if (tag === BATCH_CONTAINER_TAG_SINGLE) {
    return [plaintext.slice(1)];
  }
  if (tag !== BATCH_CONTAINER_TAG_BATCH) {
    throw new TunnelCodecError(`unknown batch container tag ${tag}`);
  }
  const frames: Uint8Array[] = [];
  let offset = 1;
  while (offset < plaintext.length) {
    if (offset + BATCH_FRAME_LENGTH_BYTES > plaintext.length) {
      throw new TunnelCodecError('truncated batch frame length');
    }
    const length =
      ((plaintext[offset] << 24) |
        (plaintext[offset + 1] << 16) |
        (plaintext[offset + 2] << 8) |
        plaintext[offset + 3]) >>>
      0;
    offset += BATCH_FRAME_LENGTH_BYTES;
    if (offset + length > plaintext.length) {
      throw new TunnelCodecError('truncated batch frame body');
    }
    frames.push(plaintext.slice(offset, offset + length));
    offset += length;
  }
  if (frames.length === 0) {
    throw new TunnelCodecError('empty frame batch');
  }
  return frames;
};

// Only high-volume body/stream data is buffered; setup/teardown/keepalive
// frames flush immediately so TTFT, terminal echo, and liveness stay snappy.
const BUFFERED_FRAME_TYPES = new Set<number>([
  TunnelFrameType.HttpBody,
  TunnelFrameType.WsText,
  TunnelFrameType.WsBinary,
]);

// 150ms: the chat render pipeline already gates visible streaming updates well below this — a
// 100ms input throttle (useStreamingTextThrottle) feeding a ~64ms paced-reveal (usePacedText) that
// buffers-and-smooths arrival bursts, and the app already tolerates 200ms under backpressure. So a
// 150ms batch window is invisible to users while cutting DO messages ~33% more than 100ms.
// Leading-edge flush keeps time-to-first-token and terminal echo instant regardless of this value.
export const DEFAULT_BATCH_WINDOW_MS = 150;
export const DEFAULT_BATCH_MAX_BYTES = 24 * 1024;
export const DEFAULT_BATCH_MAX_FRAMES = 32;

export interface OutboundFrameBatcherOptions {
  /** Trailing flush window in ms. Buffered frames flush no later than this. */
  windowMs?: number;
  maxBatchBytes?: number;
  maxBatchFrames?: number;
  /** Encrypt + write one batched plaintext to the wire. Called in enqueue order. */
  sendBatch: (plaintext: Uint8Array) => void;
  // Injectable clock/timer so tests can drive timing deterministically.
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface OutboundFrameBatcher {
  /** Buffer or immediately flush a tunnel frame per the batching policy. */
  enqueue(frame: Uint8Array): void;
  /** Force-flush any buffered frames now. */
  flush(): void;
  /** Stop the batcher; drops any un-flushed frames (channel is being torn down). */
  dispose(): void;
}

/**
 * Outbound batching buffer shared by the client and (mirrored in JS) the host
 * send paths. Policy:
 *  - Leading edge: if nothing flushed within windowMs, the frame ships now
 *    (batch of 1) — keeps time-to-first-token and keystroke echo instant.
 *  - Trailing window: subsequent body frames buffer and flush when the timer
 *    fires, buffered bytes >= maxBatchBytes, buffered frames >= maxBatchFrames,
 *    or the plaintext budget would be exceeded.
 *  - Non-buffered frame types (setup/teardown/keepalive) flush immediately, and
 *    flush any pending buffer first so per-stream ordering is preserved.
 */
export const createOutboundFrameBatcher = (
  options: OutboundFrameBatcherOptions,
): OutboundFrameBatcher => {
  const windowMs = options.windowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_BATCH_MAX_BYTES;
  const maxBatchFrames = options.maxBatchFrames ?? DEFAULT_BATCH_MAX_FRAMES;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  let buffer: Uint8Array[] = [];
  let bufferedBytes = 0; // conservative multi-envelope size estimate
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0; // 0 => idle, so the first frame takes the leading edge
  let disposed = false;

  const clearPendingTimer = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const flush = (): void => {
    clearPendingTimer();
    if (buffer.length === 0) return;
    const frames = buffer;
    buffer = [];
    bufferedBytes = 0;
    lastFlushAt = now();
    options.sendBatch(encodeFrameBatch(frames));
  };

  const enqueue = (frame: Uint8Array): void => {
    if (disposed) return;
    const frameType = frame[0] & ~TUNNEL_FRAGMENT_FLAG;
    if (!BUFFERED_FRAME_TYPES.has(frameType)) {
      // Immediate frame: append then flush so it never overtakes buffered body.
      buffer.push(frame);
      flush();
      return;
    }
    const at = now();
    if (buffer.length === 0 && at - lastFlushAt >= windowMs) {
      // Leading edge: nothing flushed recently, ship this one right away.
      buffer.push(frame);
      flush();
      return;
    }
    const frameCost = BATCH_FRAME_LENGTH_BYTES + frame.length;
    if (buffer.length > 0 && 1 + bufferedBytes + frameCost > MAX_PLAINTEXT_FRAME_BYTES) {
      flush();
    }
    buffer.push(frame);
    bufferedBytes += frameCost;
    if (bufferedBytes >= maxBatchBytes || buffer.length >= maxBatchFrames) {
      flush();
      return;
    }
    if (timer === null) timer = setTimer(flush, windowMs);
  };

  return {
    enqueue,
    flush,
    dispose(): void {
      disposed = true;
      clearPendingTimer();
      buffer = [];
      bufferedBytes = 0;
    },
  };
};

/** Allocates client-initiated stream ids: odd, starting at 1. */
export const createStreamIdAllocator = () => {
  let next = 1;
  return {
    next(): number {
      if (next > MAX_STREAM_ID) {
        throw new TunnelCodecError('stream id space exhausted');
      }
      const id = next;
      next += 2;
      return id;
    },
  };
};
