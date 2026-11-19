import { gzipSync } from 'node:zlib';

export type TerminalWsBinaryChunk = Uint8Array | ArrayBuffer;
export type TerminalWsBinaryMessage = TerminalWsBinaryChunk | TerminalWsBinaryChunk[];
export type TerminalWsJsonValue = string | number | boolean | null | TerminalWsJsonValue[] | TerminalWsJsonObject;
export interface TerminalWsJsonObject {
  [property: string]: TerminalWsJsonValue | undefined;
}

export interface TerminalWsFrameOptions {
  gzip?: boolean;
}

export const TERMINAL_WS_PATH = '/api/terminal/ws';
export const TERMINAL_WS_CONTROL_TAG_JSON = 0x01;
export const TERMINAL_WS_CONTROL_TAG_GZIP_JSON = 0x02;
const TERMINAL_WS_GZIP_MIN_BYTES = 4 * 1024;
export const TERMINAL_WS_MAX_PAYLOAD_BYTES = 64 * 1024;

const isText = (value: unknown): value is string => typeof value === 'string';
const isControlPayload = (value: TerminalWsJsonValue): value is TerminalWsJsonObject | TerminalWsJsonValue[] => value !== null && typeof value === 'object';

export const parseRequestPathname = (requestUrl: string | null | undefined) => {
  if (!isText(requestUrl) || requestUrl.length === 0) {
    return '';
  }

  try {
    return new URL(requestUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

export const isTerminalWsPathname = (pathname: string) => pathname === TERMINAL_WS_PATH;

const terminalWsChunkBuffer = (chunk: TerminalWsBinaryChunk) => {
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  return Buffer.from(chunk);
};

export const normalizeTerminalWsMessageToBuffer = (rawData: TerminalWsBinaryMessage) => {
  if (Buffer.isBuffer(rawData)) {
    return rawData;
  }

  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : terminalWsChunkBuffer(chunk))));
  }

  return terminalWsChunkBuffer(rawData);
};

export const normalizeTerminalWsMessageToText = (rawData: string | TerminalWsBinaryMessage) => {
  if (isText(rawData)) {
    return rawData;
  }

  return normalizeTerminalWsMessageToBuffer(rawData).toString('utf8');
};

export const readTerminalWsControlFrame = (rawData: TerminalWsBinaryMessage | null | undefined) => {
  if (!rawData) {
    return null;
  }

  const buffer = normalizeTerminalWsMessageToBuffer(rawData);
  if (buffer.length < 2 || buffer[0] !== TERMINAL_WS_CONTROL_TAG_JSON) {
    return null;
  }

  try {
    const parsed: TerminalWsJsonValue = JSON.parse(buffer.subarray(1).toString('utf8'));
    if (!isControlPayload(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const createTerminalWsControlFrame = (payload: TerminalWsJsonValue, { gzip = false }: TerminalWsFrameOptions = {}) => {
  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (gzip && jsonBytes.length >= TERMINAL_WS_GZIP_MIN_BYTES) {
    return Buffer.concat([Buffer.from([TERMINAL_WS_CONTROL_TAG_GZIP_JSON]), gzipSync(jsonBytes)]);
  }
  return Buffer.concat([Buffer.from([TERMINAL_WS_CONTROL_TAG_JSON]), jsonBytes]);
};

export const pruneRebindTimestamps = (timestamps: number[], now: number, windowMs: number) =>
  timestamps.filter((timestamp) => now - timestamp < windowMs);

export const isRebindRateLimited = (timestamps: number[], maxPerWindow: number) => timestamps.length >= maxPerWindow;
