
import { MAX_PLAINTEXT_FRAME_BYTES } from './e2ee.js';


const TUNNEL_FRAME_HEADER_BYTES = 5;
const TUNNEL_FRAGMENT_FLAG = 0x80;

const BATCH_CONTAINER_TAG_SINGLE = 0x00;
const BATCH_CONTAINER_TAG_BATCH = 0x01;
const BATCH_FRAME_LENGTH_BYTES = 4;
const BATCH_ENVELOPE_RESERVED_BYTES = 1 + BATCH_FRAME_LENGTH_BYTES;
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
  DeliveryAck: 13,
};

const TUNNEL_FRAME_TYPE_VALUES = new Set(Object.values(TunnelFrameType));

const isTunnelFrameType = (value: number) => TUNNEL_FRAME_TYPE_VALUES.has(value);

export interface TunnelFrame {
  frameType: number;
  streamId: number;
  payload: Uint8Array<ArrayBuffer>;
  hasMoreFragments: boolean;
}

const frameByte = (bytes: Uint8Array, offset: number): number => {
  const byte = bytes[offset];
  if (byte === undefined) throw new TunnelCodecError('tunnel frame too short');
  return byte;
};

const MAX_STREAM_ID = 0xffffffff;

export const decodeDeliveryAck = (payload: Uint8Array) => {
  if (payload.length !== 8) throw new Error('invalid delivery acknowledgement');
  const bytes = Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0));
  if (!Number.isSafeInteger(bytes)) throw new Error('invalid delivery acknowledgement');
  return bytes;
};

export class TunnelCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelCodecError';
  }
}

export const encodeTunnelFrame = (frameType: number, streamId: number, payload: Uint8Array, hasMoreFragments = false) => {
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
  const rawType = frameByte(frame, 0);
  const hasMoreFragments = (rawType & TUNNEL_FRAGMENT_FLAG) !== 0;
  const frameType = rawType & ~TUNNEL_FRAGMENT_FLAG;
  if (!isTunnelFrameType(frameType)) {
    throw new TunnelCodecError(`unknown tunnel frame type ${frameType}`);
  }
  const streamId = ((frameByte(frame, 1) << 24) | (frameByte(frame, 2) << 16) | (frameByte(frame, 3) << 8) | frameByte(frame, 4)) >>> 0;
  return {
    frameType,
    streamId,
    payload: frame.slice(TUNNEL_FRAME_HEADER_BYTES),
    hasMoreFragments,
  };
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const encodeJsonPayload = <T>(value: T) => textEncoder.encode(JSON.stringify(value));

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

export const chunkPayload = (bytes: Uint8Array, chunkSize = MAX_TUNNEL_PAYLOAD_BYTES) => {
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

export const encodeFragmentedMessage = (frameType: number, streamId: number, payload: Uint8Array) => {
  const chunks = chunkPayload(payload);
  return chunks.map((chunk, index) => encodeTunnelFrame(frameType, streamId, chunk, index < chunks.length - 1));
};

export const createFragmentAssembler = (maxMessageBytes = 16 * 1024 * 1024) => {
  const pending = new Map<string, { chunks: Uint8Array[]; totalBytes: number }>();
  return {
    push(frame: TunnelFrame) {
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
    dropStream(streamId: number) {
      for (const key of pending.keys()) {
        if (key.startsWith(`${streamId}:`)) pending.delete(key);
      }
    },
  };
};

export const encodeFrameBatch = (frames: Uint8Array[]) => {
  if (frames.length === 0) {
    throw new TunnelCodecError('cannot encode an empty frame batch');
  }
  if (frames.length === 1) {
    const frame = frames[0];
    if (!frame) throw new TunnelCodecError('cannot encode an empty frame batch');
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

export const decodeFrameBatch = (plaintext: Uint8Array) => {
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
      ((frameByte(plaintext, offset) << 24)
        | (frameByte(plaintext, offset + 1) << 16)
        | (frameByte(plaintext, offset + 2) << 8)
        | frameByte(plaintext, offset + 3)) >>> 0;
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

const BUFFERED_FRAME_TYPES = new Set([
  TunnelFrameType.HttpBody,
  TunnelFrameType.WsText,
  TunnelFrameType.WsBinary,
]);

const DEFAULT_BATCH_WINDOW_MS = 150;
const DEFAULT_BATCH_MAX_BYTES = 24 * 1024;
const DEFAULT_BATCH_MAX_FRAMES = 32;

export interface OutboundFrameBatcherOptions {
  windowMs?: number;
  maxBatchBytes?: number;
  maxBatchFrames?: number;
  sendBatch: (plaintext: Uint8Array<ArrayBuffer>) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}
export const createOutboundFrameBatcher = (options: OutboundFrameBatcherOptions) => {
  const windowMs = options.windowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_BATCH_MAX_BYTES;
  const maxBatchFrames = options.maxBatchFrames ?? DEFAULT_BATCH_MAX_FRAMES;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  let buffer: Uint8Array[] = [];
  let bufferedBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
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

  const enqueue = (frame: Uint8Array) => {
    if (disposed) return;
    const frameType = (frame[0] ?? 0) & ~TUNNEL_FRAGMENT_FLAG;
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
