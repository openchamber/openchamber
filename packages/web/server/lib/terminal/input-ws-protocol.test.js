import { describe, expect, it } from 'bun:test';

import {
  TERMINAL_INPUT_WS_CONTROL_TAG_JSON,
  TERMINAL_INPUT_WS_PATH,
  createTerminalInputWsControlFrame,
  isRebindRateLimited,
  normalizeTerminalInputWsMessageToBuffer,
  normalizeTerminalInputWsMessageToText,
  parseRequestPathname,
  pruneRebindTimestamps,
  readTerminalInputWsControlFrame,
} from './input-ws-protocol.js';

describe('terminal input websocket protocol', () => {
  it('uses fixed websocket path', () => {
    expect(TERMINAL_INPUT_WS_PATH).toBe('/api/terminal/input-ws');
  });

  it('encodes control frames with control tag prefix', () => {
    const frame = createTerminalInputWsControlFrame({ t: 'ok', v: 1 });
    expect(frame[0]).toBe(TERMINAL_INPUT_WS_CONTROL_TAG_JSON);
  });

  it('roundtrips control frame payload', () => {
    const payload = { t: 'b', s: 'abc123', v: 1 };
    const frame = createTerminalInputWsControlFrame(payload);
    expect(readTerminalInputWsControlFrame(frame)).toEqual(payload);
  });

  it('rejects control frame without protocol tag', () => {
    const frame = Buffer.from(JSON.stringify({ t: 'b', s: 'abc123' }), 'utf8');
    expect(readTerminalInputWsControlFrame(frame)).toBeNull();
  });

  it('rejects malformed control json', () => {
    const frame = Buffer.concat([
      Buffer.from([TERMINAL_INPUT_WS_CONTROL_TAG_JSON]),
      Buffer.from('{not json', 'utf8'),
    ]);
    expect(readTerminalInputWsControlFrame(frame)).toBeNull();
  });

  it('rejects empty control payloads', () => {
    expect(readTerminalInputWsControlFrame(null)).toBeNull();
    expect(readTerminalInputWsControlFrame(undefined)).toBeNull();
    expect(readTerminalInputWsControlFrame(Buffer.alloc(0))).toBeNull();
  });

  it('rejects control json that is not object', () => {
    const frame = Buffer.concat([
      Buffer.from([TERMINAL_INPUT_WS_CONTROL_TAG_JSON]),
      Buffer.from('"str"', 'utf8'),
    ]);
    expect(readTerminalInputWsControlFrame(frame)).toBeNull();
  });

  it('parses control frame from chunk arrays', () => {
    const frame = createTerminalInputWsControlFrame({ t: 'bok', v: 1 });
    const chunks = [frame.subarray(0, 2), frame.subarray(2)];
    expect(readTerminalInputWsControlFrame(chunks)).toEqual({ t: 'bok', v: 1 });
  });

  it('normalizes buffer passthrough', () => {
    const raw = Buffer.from('abc', 'utf8');
    const normalized = normalizeTerminalInputWsMessageToBuffer(raw);
    expect(normalized).toBe(raw);
    expect(normalized.toString('utf8')).toBe('abc');
  });

  it('normalizes uint8 arrays', () => {
    const normalized = normalizeTerminalInputWsMessageToBuffer(new Uint8Array([97, 98, 99]));
    expect(normalized.toString('utf8')).toBe('abc');
  });

  it('normalizes array buffer payloads', () => {
    const source = new Uint8Array([97, 98, 99]).buffer;
    const normalized = normalizeTerminalInputWsMessageToBuffer(source);
    expect(normalized.toString('utf8')).toBe('abc');
  });

  it('normalizes chunk array payloads', () => {
    const normalized = normalizeTerminalInputWsMessageToBuffer([
      Buffer.from('ab', 'utf8'),
      Buffer.from('c', 'utf8'),
    ]);
    expect(normalized.toString('utf8')).toBe('abc');
  });

  it('normalizes text payload from string', () => {
    expect(normalizeTerminalInputWsMessageToText('\u001b[A')).toBe('\u001b[A');
  });

  it('normalizes text payload from binary data', () => {
    expect(normalizeTerminalInputWsMessageToText(Buffer.from('\r', 'utf8'))).toBe('\r');
  });

  it('parses relative request pathname', () => {
    expect(parseRequestPathname('/api/terminal/input-ws?x=1')).toBe('/api/terminal/input-ws');
  });

  it('parses absolute request pathname', () => {
    expect(parseRequestPathname('http://localhost:3000/api/terminal/input-ws')).toBe('/api/terminal/input-ws');
  });

  it('returns empty pathname for non-string request url', () => {
    expect(parseRequestPathname(null)).toBe('');
  });

  it('returns empty pathname for invalid request url', () => {
    expect(parseRequestPathname('http://')).toBe('');
    expect(parseRequestPathname('')).toBe('');
  });

  it('prunes stale rebind timestamps', () => {
    const now = 1_000;
    const pruned = pruneRebindTimestamps([100, 200, 950, 999], now, 100);
    expect(pruned).toEqual([950, 999]);
  });

  it('keeps rebind timestamps within active window', () => {
    const now = 1_000;
    const pruned = pruneRebindTimestamps([920, 950, 999], now, 100);
    expect(pruned).toEqual([920, 950, 999]);
  });

  it('does not rate limit below threshold', () => {
    expect(isRebindRateLimited([1, 2, 3], 4)).toBe(false);
  });

  it('does not rate limit empty window', () => {
    expect(isRebindRateLimited([], 1)).toBe(false);
  });

  it('rate limits at threshold', () => {
    expect(isRebindRateLimited([1, 2, 3, 4], 4)).toBe(true);
  });
});
