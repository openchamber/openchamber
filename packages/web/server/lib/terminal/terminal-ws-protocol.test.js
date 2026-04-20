import { describe, expect, it } from 'vitest';

import {
  TERMINAL_WS_PATH,
  TERMINAL_WS_CONTROL_TAG_JSON,
  createTerminalWsControlFrame,
  isTerminalWsPathname,
  isRebindRateLimited,
  normalizeTerminalWsMessageToBuffer,
  normalizeTerminalWsMessageToText,
  parseRequestPathname,
  pruneRebindTimestamps,
  readTerminalWsControlFrame,
} from './terminal-ws-protocol.js';

describe('terminal websocket protocol', () => {
  it('uses fixed websocket paths', () => {
    expect(TERMINAL_WS_PATH).toBe('/api/terminal/ws');
  });

  it('matches supported websocket pathnames', () => {
    expect(isTerminalWsPathname('/api/terminal/ws')).toBe(true);
    expect(isTerminalWsPathname('/api/terminal/input-ws')).toBe(false);
    expect(isTerminalWsPathname('/api/terminal/other')).toBe(false);
  });

  it('encodes control frames with control tag prefix', () => {
    const frame = createTerminalWsControlFrame({ t: 'ok', v: 1 });
    expect(frame[0]).toBe(TERMINAL_WS_CONTROL_TAG_JSON);
  });

  it('roundtrips control frame payload', () => {
    const payload = { t: 'b', s: 'abc123', v: 1 };
    const frame = createTerminalWsControlFrame(payload);
    expect(readTerminalWsControlFrame(frame)).toEqual(payload);
  });

  it('rejects control frame without protocol tag', () => {
    const frame = Buffer.from(JSON.stringify({ t: 'b', s: 'abc123' }), 'utf8');
    expect(readTerminalWsControlFrame(frame)).toBeNull();
  });

  it('rejects malformed control json', () => {
    const frame = Buffer.concat([
      Buffer.from([TERMINAL_WS_CONTROL_TAG_JSON]),
      Buffer.from('{not json', 'utf8'),
    ]);
    expect(readTerminalWsControlFrame(frame)).toBeNull();
  });

  it('rejects empty control payloads', () => {
    expect(readTerminalWsControlFrame(null)).toBeNull();
    expect(readTerminalWsControlFrame(undefined)).toBeNull();
    expect(readTerminalWsControlFrame(Buffer.alloc(0))).toBeNull();
  });

  it('rejects control json that is not object', () => {
    const frame = Buffer.concat([
      Buffer.from([TERMINAL_WS_CONTROL_TAG_JSON]),
      Buffer.from('"str"', 'utf8'),
    ]);
    expect(readTerminalWsControlFrame(frame)).toBeNull();
  });

  it('parses control frame from chunk arrays', () => {
    const frame = createTerminalWsControlFrame({ t: 'bok', v: 1 });
    const chunks = [frame.subarray(0, 2), frame.subarray(2)];
    expect(readTerminalWsControlFrame(chunks)).toEqual({ t: 'bok', v: 1 });
  });

  it('normalizes buffer passthrough', () => {
    const raw = Buffer.from('abc', 'utf8');
    const normalized = normalizeTerminalWsMessageToBuffer(raw);
    expect(normalized).toBe(raw);
    expect(normalized.toString('utf8')).toBe('abc');
  });

  it('normalizes uint8 arrays', () => {
    const normalized = normalizeTerminalWsMessageToBuffer(new Uint8Array([97, 98, 99]));
    expect(normalized.toString('utf8')).toBe('abc');
  });

  it('normalizes array buffer payloads', () => {
    const source = new Uint8Array([97, 98, 99]).buffer;
    const normalized = normalizeTerminalWsMessageToBuffer(source);
    expect(normalized.toString('utf8')).toBe('abc');
  });

  it('normalizes chunk array payloads', () => {
    const normalized = normalizeTerminalWsMessageToBuffer([
      Buffer.from('ab', 'utf8'),
      Buffer.from('c', 'utf8'),
    ]);
    expect(normalized.toString('utf8')).toBe('abc');
  });

  it('normalizes text payload from string', () => {
    expect(normalizeTerminalWsMessageToText('\u001b[A')).toBe('\u001b[A');
  });

  it('normalizes text payload from binary data', () => {
    expect(normalizeTerminalWsMessageToText(Buffer.from('\r', 'utf8'))).toBe('\r');
  });

  it('parses relative request pathname', () => {
    expect(parseRequestPathname('/api/terminal/ws?x=1')).toBe('/api/terminal/ws');
  });

  it('parses absolute request pathname', () => {
    expect(parseRequestPathname('http://localhost:3000/api/terminal/ws')).toBe('/api/terminal/ws');
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
