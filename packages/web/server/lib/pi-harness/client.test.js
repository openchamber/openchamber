import { describe, expect, test } from 'bun:test';
import { createPiHarnessClient } from './client.js';

describe('Pi-Harness client', () => {
  test('sends x-api-key only when configured', async () => {
    const calls = [];
    const client = createPiHarnessClient({
      baseUrl: 'http://pi.test',
      apiKey: 'secret',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        return new Response(JSON.stringify({ status: 'ok', sessions: 0, uptime: 1, version: 'test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.health();
    expect(calls[0].url).toBe('http://pi.test/health');
    expect(calls[0].headers['x-api-key']).toBe('secret');
  });

  test('does not send x-api-key when not configured', async () => {
    const calls = [];
    const client = createPiHarnessClient({
      baseUrl: 'http://pi.test',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.listSessions();
    expect(calls[0].url).toBe('http://pi.test/sessions');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
  });

  test('throws with status and body on non-2xx JSON request', async () => {
    const client = createPiHarnessClient({
      baseUrl: 'http://pi.test',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'bad' }), { status: 500 }),
    });

    await expect(client.getSession('missing')).rejects.toThrow(
      'Pi-Harness GET sessions/missing failed (500)',
    );
  });

  test('creates sessions and preserves workspaceDir', async () => {
    const calls = [];
    const client = createPiHarnessClient({
      baseUrl: 'http://pi.test',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ sessionId: 'pi-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await client.createSession({ sessionId: 'pi-1', workspaceDir: '/repo', provider: 'p', model: 'm' });
    expect(result).toEqual({ sessionId: 'pi-1' });
    expect(calls[0].url).toBe('http://pi.test/sessions');
    expect(calls[0].body).toEqual({ sessionId: 'pi-1', workspaceDir: '/repo', provider: 'p', model: 'm' });
  });

  test('sendMessageStream returns raw response for SSE consumption', async () => {
    const client = createPiHarnessClient({
      baseUrl: 'http://pi.test',
      fetchImpl: async () =>
        new Response('event: test\ndata: {"x":1}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    });

    const response = await client.sendMessageStream('s1', { content: 'hi' });
    const text = await response.text();
    expect(text).toContain('event: test');
  });
});
