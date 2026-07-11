// Tunnel mux frame codec (Layer 3 of the protocol spec). Pure functions, no I/O.
// JS mirror of packages/ui/src/lib/relay/tunnel-codec.ts (+ the Layer 3
// constants from protocol.ts) — MUST stay byte-compatible with those modules.
// Frame layout: [1 byte frameType (high bit = fragment-continues)][4 byte BE streamId][payload].
// Client-initiated streams use odd streamIds starting at 1; even ids are reserved.
// Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 3).

import { MAX_PLAINTEXT_FRAME_BYTES } from './e2ee.js';


export const TUNNEL_FRAME_HEADER_BYTES = 5;
export const TUNNEL_FRAGMENT_FLAG = 0x80;

// Batch envelope container (mirror of protocol.ts). Only used when both peers
// negotiated `batch`. Reserve the per-frame envelope overhead from the payload
// budget so any single frame still fits one 64 KiB encrypted plaintext.
export const BATCH_CONTAINER_TAG_SINGLE = 0x00;
export const BATCH_CONTAINER_TAG_BATCH = 0x01;
export const BATCH_FRAME_LENGTH_BYTES = 4;
export const BATCH_ENVELOPE_RESERVED_BYTES = 1 + BATCH_FRAME_LENGTH_BYTES;
export const MAX_TUNNEL_PAYLOAD_BYTES =
  MAX_PLAINTEXT_FRAME_BYTES - TUNNEL_FRAME_HEADER_BYTES - BATCH_ENVELOPE_RESERVED_BYTES;

export const TunnelFrameType = {
  HttpRequest: 1,
  HttpBody: 2,
  HttpResponse: 3,
  StreamEnd: 4,
  StreamAbort: 5,
  WsOpen: 6,
  WsOpened: 7,
  WsText: 8,
  WsBinary: 9,
  WsClose: 10,
  Ping: 11,
  Pong: 12,
};

const TUNNEL_FRAME_TYPE_VALUES = new Set(Object.values(TunnelFrameType));

/** @param {number} value */
export const isTunnelFrameType = (value) => TUNNEL_FRAME_TYPE_VALUES.has(value);

const MAX_STREAM_ID = 0xffffffff;

export class TunnelCodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TunnelCodecError';
  }
}

/**
 * @param {number} frameType
 * @param {number} streamId
 * @param {Uint8Array} payload
 * @param {boolean} [hasMoreFragments]
 */
export const encodeTunnelFrame = (frameType, streamId, payload, hasMoreFragments = false) => {
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

/**
 * @param {Uint8Array} frame
 * @returns {{ frameType: number, streamId: number, payload: Uint8Array, hasMoreFragments: boolean }}
 */
export const decodeTunnelFrame = (frame) => {
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

/** @param {unknown} value */
export const encodeJsonPayload = (value) => textEncoder.encode(JSON.stringify(value));

/**
 * @param {Uint8Array} payload
 * @param {(parsed: unknown) => boolean} validate
 */
export const decodeJsonPayload = (payload, validate) => {
  let parsed;
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

/**
 * Split a body/message into payload-sized chunks. Empty input yields one empty chunk.
 * @param {Uint8Array} bytes
 * @param {number} [chunkSize]
 */
export const chunkPayload = (bytes, chunkSize = MAX_TUNNEL_PAYLOAD_BYTES) => {
  if (chunkSize <= 0 || chunkSize > MAX_TUNNEL_PAYLOAD_BYTES) {
    throw new TunnelCodecError('invalid chunk size');
  }
  if (bytes.length === 0) return [new Uint8Array(0)];
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks;
};

/**
 * Encode one logical message as one or more frames, setting the fragment flag
 * on all but the last. Used for WS messages that exceed the frame budget.
 * @param {number} frameType
 * @param {number} streamId
 * @param {Uint8Array} payload
 */
export const encodeFragmentedMessage = (frameType, streamId, payload) => {
  const chunks = chunkPayload(payload);
  return chunks.map((chunk, index) => encodeTunnelFrame(frameType, streamId, chunk, index < chunks.length - 1));
};

/**
 * Reassembles fragmented messages per (streamId, frameType). Bounded to protect memory.
 * @param {number} [maxMessageBytes]
 */
export const createFragmentAssembler = (maxMessageBytes = 16 * 1024 * 1024) => {
  const pending = new Map();
  return {
    /**
     * Returns the complete message payload once all fragments arrived, or null
     * while more fragments are expected.
     * @param {{ frameType: number, streamId: number, payload: Uint8Array, hasMoreFragments: boolean }} frame
     */
    push(frame) {
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
    /** @param {number} streamId */
    dropStream(streamId) {
      for (const key of pending.keys()) {
        if (key.startsWith(`${streamId}:`)) pending.delete(key);
      }
    },
  };
};

/**
 * Batch envelope encoder (mirror of tunnel-codec.ts encodeFrameBatch). Only used
 * when both peers negotiated `batch`. One encrypted WS message still equals one
 * encrypt() call — this only changes how many tunnel frames it carries.
 * @param {Uint8Array[]} frames
 * @returns {Uint8Array}
 */
export const encodeFrameBatch = (frames) => {
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

/**
 * Decodes a batch-envelope plaintext into its ordered tunnel frames.
 * @param {Uint8Array} plaintext
 * @returns {Uint8Array[]}
 */
export const decodeFrameBatch = (plaintext) => {
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
  const frames = [];
  let offset = 1;
  while (offset < plaintext.length) {
    if (offset + BATCH_FRAME_LENGTH_BYTES > plaintext.length) {
      throw new TunnelCodecError('truncated batch frame length');
    }
    const length =
      ((plaintext[offset] << 24)
        | (plaintext[offset + 1] << 16)
        | (plaintext[offset + 2] << 8)
        | plaintext[offset + 3]) >>> 0;
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

// Only high-volume body/stream data is buffered; setup/teardown/keepalive frames
// flush immediately so TTFT, terminal echo, and liveness stay snappy.
const BUFFERED_FRAME_TYPES = new Set([
  TunnelFrameType.HttpBody,
  TunnelFrameType.WsText,
  TunnelFrameType.WsBinary,
]);

// See the TS mirror (tunnel-codec.ts) for the 150ms rationale: the chat render pipeline's
// 100ms input throttle + ~64ms paced-reveal smoothing make a 150ms batch window invisible.
export const DEFAULT_BATCH_WINDOW_MS = 150;
export const DEFAULT_BATCH_MAX_BYTES = 24 * 1024;
export const DEFAULT_BATCH_MAX_FRAMES = 32;

/**
 * Outbound batching buffer (mirror of tunnel-codec.ts createOutboundFrameBatcher).
 * @param {{
 *   windowMs?: number,
 *   maxBatchBytes?: number,
 *   maxBatchFrames?: number,
 *   sendBatch: (plaintext: Uint8Array) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} options
 */
export const createOutboundFrameBatcher = (options) => {
  const windowMs = options.windowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_BATCH_MAX_BYTES;
  const maxBatchFrames = options.maxBatchFrames ?? DEFAULT_BATCH_MAX_FRAMES;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  let buffer = [];
  let bufferedBytes = 0;
  let timer = null;
  let lastFlushAt = 0;
  let disposed = false;

  const clearPendingTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearPendingTimer();
    if (buffer.length === 0) return;
    const frames = buffer;
    buffer = [];
    bufferedBytes = 0;
    lastFlushAt = now();
    options.sendBatch(encodeFrameBatch(frames));
  };

  const enqueue = (frame) => {
    if (disposed) return;
    const frameType = frame[0] & ~TUNNEL_FRAGMENT_FLAG;
    if (!BUFFERED_FRAME_TYPES.has(frameType)) {
      buffer.push(frame);
      flush();
      return;
    }
    const at = now();
    if (buffer.length === 0 && at - lastFlushAt >= windowMs) {
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
    dispose() {
      disposed = true;
      clearPendingTimer();
      buffer = [];
      bufferedBytes = 0;
    },
  };
};
