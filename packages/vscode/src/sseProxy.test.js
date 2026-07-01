import { afterEach, describe, expect, it, mock } from 'bun:test';

const originalFetch = globalThis.fetch;
const { openSseProxy } = await import('./sseProxy');

const createManager = () => ({
  getStatus: () => 'connected',
  getApiUrl: () => 'http://127.0.0.1:4096/',
  getWorkingDirectory: () => '/repo',
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
  onStatusChange: () => ({ dispose() {} }),
});

const createSseResponse = (chunks) => {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
};

describe('VS Code SSE proxy', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('forwards upstream SSE chunks without reserializing event data', async () => {
    const upstreamChunks = [
      'id: evt-1\n',
      'data: {"type":"message.part.delta","properties":{"delta":"hi"}}\n\n',
    ];
    let fetchInput;
    let fetchInit;
    globalThis.fetch = mock((input, init) => {
      fetchInput = input;
      fetchInit = init;
      return Promise.resolve(createSseResponse(upstreamChunks));
    });

    const received = [];
    const controller = new AbortController();
    const proxy = await openSseProxy({
      manager: createManager(),
      path: '/global/event',
      headers: { 'Last-Event-ID': 'evt-0' },
      signal: controller.signal,
      onChunk: (chunk) => received.push(chunk),
    });

    await proxy.run;

    expect(fetchInput).toBe('http://127.0.0.1:4096/global/event');
    expect(fetchInit.headers.Authorization).toBe('Bearer test-token');
    expect(fetchInit.headers['Last-Event-ID']).toBe('evt-0');
    expect(proxy.headers['content-type']).toContain('text/event-stream');
    expect(received.join('')).toBe(upstreamChunks.join(''));
  });

  it('adds the active directory for directory-scoped event streams', async () => {
    let fetchInput;
    globalThis.fetch = mock((input) => {
      fetchInput = input;
      return Promise.resolve(createSseResponse(['data: {"type":"server.connected"}\n\n']));
    });

    const proxy = await openSseProxy({
      manager: createManager(),
      path: '/event?foo=bar',
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    await proxy.run;

    const url = new URL(fetchInput);
    expect(url.pathname).toBe('/event');
    expect(url.searchParams.get('foo')).toBe('bar');
    expect(url.searchParams.get('directory')).toBe('/repo');
  });
});
