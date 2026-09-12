import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInspectorCapture } from './inspector-capture.js';

const requestEvent = (requestId, overrides = {}) => ({
  requestId, timestamp: 10, wallTime: 1_750_000_000,
  type: 'Fetch', request: { url: 'https://example.test/api?token=private', method: 'POST',
    headers: { Authorization: 'Bearer private', 'Content-Type': 'application/json' }, hasPostData: true }, ...overrides,
});

const setup = (canSend = () => true) => {
  const messages = [];
  const capture = createInspectorCapture({ captureId: 'capture-1', tabId: 'sc:page-1',
    send: (message) => { messages.push(message); return true; }, canSend, startedAt: 1_750_000_000_000 });
  return { capture, messages };
};

afterEach(() => vi.useRealTimers());

describe('inspector capture bounds and network records', () => {
  it('publishes nothing before startup completes, then batches at 100 ms', () => {
    vi.useFakeTimers();
    const { capture, messages } = setup();
    capture.event('Network.requestWillBeSent', requestEvent('request-1'));
    vi.advanceTimersByTime(500);
    expect(messages).toEqual([]);
    capture.start();
    vi.advanceTimersByTime(99);
    expect(messages).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].network[0]).toMatchObject({ method: 'POST', state: 'pending', status: null });
    expect(JSON.stringify(messages)).not.toContain('private');
    capture.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps redirect hops separate and never offers the final response body for an earlier hop', () => {
    vi.useFakeTimers();
    const { capture, messages } = setup();
    capture.start();
    capture.event('Network.requestWillBeSent', requestEvent('request-1'));
    capture.event('Network.requestWillBeSent', requestEvent('request-1', {
      timestamp: 10.2, redirectResponse: { status: 302, statusText: 'Found', mimeType: 'text/html',
        encodedDataLength: 120, headers: { Location: 'https://example.test/done?token=private' } },
      request: { url: 'https://example.test/done', method: 'GET', headers: {} },
    }));
    capture.event('Network.responseReceived', { requestId: 'request-1', timestamp: 10.4,
      response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'Set-Cookie': 'private' }, fromDiskCache: true } });
    capture.event('Network.loadingFinished', { requestId: 'request-1', timestamp: 10.5, encodedDataLength: 240 });
    vi.advanceTimersByTime(100);
    const entries = messages.flatMap((message) => message.network);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ status: 302, state: 'complete', encodedBytes: 120 });
    expect(entries[1]).toMatchObject({ status: 200, state: 'complete', fromCache: true, encodedBytes: 240 });
    expect(entries[0].id).not.toBe(entries[1].id);
    expect(entries[0].durationMs).toBeCloseTo(200);
    expect(entries[1].durationMs).toBeCloseTo(300);
    expect(capture.request(entries[0].id).redirected).toBe(true);
    expect(capture.request(entries[1].id).redirected).toBe(false);
    expect(JSON.stringify(entries)).not.toContain('private');
    capture.dispose();
  });

  it('tracks failures, cache events and ignores completions from before capture or clear', () => {
    vi.useFakeTimers();
    const { capture, messages } = setup();
    capture.start();
    capture.event('Network.loadingFinished', { requestId: 'earlier', timestamp: 20, encodedDataLength: 4 });
    capture.event('Network.requestWillBeSent', requestEvent('failure'));
    capture.event('Network.requestServedFromCache', { requestId: 'failure' });
    capture.event('Network.loadingFailed', { requestId: 'failure', timestamp: 11, canceled: true, errorText: 'net::ERR_ABORTED' });
    vi.advanceTimersByTime(100);
    expect(messages[0].network).toHaveLength(1);
    expect(messages[0].network[0]).toMatchObject({ state: 'failed', fromCache: true, durationMs: 1_000, failureText: 'Request canceled' });
    const id = messages[0].network[0].id;
    capture.clear('network');
    capture.event('Network.loadingFinished', { requestId: 'failure', timestamp: 12, encodedDataLength: 8 });
    vi.advanceTimersByTime(100);
    expect(capture.request(id)).toBeNull();
    expect(messages).toHaveLength(1);
    capture.dispose();
  });

  it('bounds a 1000-console, 300-request burst and does not send into a backed-up socket', () => {
    vi.useFakeTimers();
    let writable = false;
    const { capture, messages } = setup(() => writable);
    capture.start();
    for (let index = 0; index < 1_000; index += 1) capture.event('Runtime.consoleAPICalled', {
      type: 'log', timestamp: 1_750_000_000_001 + index, args: [{ type: 'string', value: `log-${index}` }],
    });
    for (let index = 0; index < 300; index += 1) capture.event('Network.requestWillBeSent', requestEvent(`request-${index}`));
    vi.advanceTimersByTime(1_000);
    expect(messages).toHaveLength(0);
    writable = true;
    vi.advanceTimersByTime(2_000);
    expect(messages.length).toBeLessThanOrEqual(20);
    expect(messages.flatMap((message) => message.console)).toHaveLength(300);
    expect(messages.flatMap((message) => message.network)).toHaveLength(200);
    for (const message of messages) {
      expect(message.console.length + message.network.length).toBeLessThanOrEqual(32);
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(48 * 1024);
      expect(message.droppedConsole).toBe(700);
      expect(message.droppedNetwork).toBe(100);
    }
    capture.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the byte budget with large headers and escaped console text', () => {
    vi.useFakeTimers();
    const { capture, messages } = setup();
    capture.start();
    const headers = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`Header-${index}`, '\u0000'.repeat(1_024)]));
    for (let index = 0; index < 300; index += 1) capture.event('Runtime.consoleAPICalled', {
      type: 'log', timestamp: 1_750_000_000_001 + index, args: [{ type: 'string', value: '\u0000'.repeat(4_000) }],
    });
    for (let index = 0; index < 200; index += 1) capture.event('Network.requestWillBeSent', requestEvent(`large-${index}`, {
      request: { url: 'https://example.test/', method: 'GET', headers },
    }));
    vi.advanceTimersByTime(3_000);
    expect(messages.length).toBeLessThanOrEqual(30);
    expect(messages.at(-1).droppedNetwork).toBeGreaterThan(0);
    const retained = messages.flatMap((message) => message.network).map((entry) => capture.request(entry.id)).filter(Boolean);
    expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(messages.every((message) => Buffer.byteLength(JSON.stringify(message)) <= 48 * 1024)).toBe(true);
    capture.dispose();
  });

  it('does not replay historical console messages and clear removes only its pending scope', () => {
    vi.useFakeTimers();
    const { capture, messages } = setup();
    capture.start();
    capture.event('Runtime.consoleAPICalled', { type: 'log', timestamp: 1_749_000_000_000, args: [{ type: 'string', value: 'historical' }] });
    capture.event('Runtime.consoleAPICalled', { type: 'log', timestamp: 1_750_000_000_001, args: [{ type: 'string', value: 'current' }] });
    capture.event('Network.requestWillBeSent', requestEvent('request-1'));
    capture.clear('console');
    vi.advanceTimersByTime(100);
    expect(messages[0].console).toEqual([]);
    expect(messages[0].network).toHaveLength(1);
    capture.dispose();
  });

  it('resets only the cleared drop count and gives network room between large console batches', () => {
    vi.useFakeTimers();
    const { capture, messages } = setup();
    capture.start();
    for (let index = 0; index < 350; index += 1) capture.event('Runtime.consoleAPICalled', {
      type: 'log', timestamp: 1_750_000_000_001 + index, args: [{ type: 'string', value: '\u0000'.repeat(4_000) }],
      stackTrace: { callFrames: [{ url: `https://example.test/${'x'.repeat(2_000)}` }] },
    });
    for (let index = 0; index < 210; index += 1) capture.event('Network.requestWillBeSent', requestEvent(`network-${index}`));
    vi.advanceTimersByTime(200);
    expect(messages.some((message) => message.network.length > 0)).toBe(true);
    expect(messages.at(-1).droppedConsole).toBeGreaterThan(0);
    expect(messages.at(-1).droppedNetwork).toBe(10);
    capture.clear('console');
    vi.advanceTimersByTime(100);
    expect(messages.at(-1).droppedConsole).toBe(0);
    expect(messages.at(-1).droppedNetwork).toBe(10);
    capture.dispose();
  });
});
