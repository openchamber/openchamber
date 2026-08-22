import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

// No global body parser on purpose: the real server parses JSON per-route, so
// these tests must fail if the pending route loses its own parser again.
const createApp = (overrides = {}) => {
  const app = express();
  const dependencies = {
    buildOpenCodeUrl: (path) => `http://opencode.local${path}`,
    getOpenCodeAuthHeaders: () => ({ 'x-opencode-auth': 'test' }),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

const queuePending = (app, { state, name, directory = null, origin = null }) =>
  request(app)
    .post('/api/mcp/auth/pending')
    .send({ state, name, directory, origin })
    .expect(200);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MCP OAuth browser callback route', () => {
  it('completes authorization server-side for a parked state and clears it', async () => {
    const upstreamFetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', upstreamFetch);
    const { app } = createApp();
    await queuePending(app, { state: 'state-1', name: 'linear', directory: '/projects/demo', origin: 'desktop' });

    const response = await request(app)
      .get('/mcp/oauth/callback')
      .query({ state: 'state-1', code: 'auth-code', server: 'linear' })
      .expect(200);

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0];
    expect(String(url)).toBe('http://opencode.local/mcp/linear/auth/callback?directory=%2Fprojects%2Fdemo');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ code: 'auth-code' });
    expect(init.headers['x-opencode-auth']).toBe('test');

    expect(response.text).toContain('Authorization Complete');
    // Started from the desktop shell: the page hands control back via deep link.
    expect(response.text).toContain('openchamber://focus/mcp-auth');

    await request(app).get('/api/mcp/auth/pending').query({ state: 'state-1' }).expect(404);
  });

  it('never forwards a code whose state is unknown', async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal('fetch', upstreamFetch);
    const { app } = createApp();

    const response = await request(app)
      .get('/mcp/oauth/callback')
      .query({ state: 'forged', code: 'attacker-code', server: 'linear' })
      .expect(400);

    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(response.text).toContain('Authorization Failed');
  });

  it('omits the desktop deep link for flows started outside the desktop shell', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { app } = createApp();
    await queuePending(app, { state: 'state-web', name: 'linear' });

    const response = await request(app)
      .get('/mcp/oauth/callback')
      .query({ state: 'state-web', code: 'auth-code' })
      .expect(200);

    expect(response.text).not.toContain('openchamber://');
  });

  it('reports a provider error without contacting OpenCode', async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal('fetch', upstreamFetch);
    const { app } = createApp();
    await queuePending(app, { state: 'state-2', name: 'linear' });

    const response = await request(app)
      .get('/mcp/oauth/callback')
      .query({ state: 'state-2', error: 'access_denied', error_description: 'User <denied> access' })
      .expect(400);

    expect(upstreamFetch).not.toHaveBeenCalled();
    // Interpolated provider text is escaped, not rendered as markup.
    expect(response.text).toContain('User &lt;denied&gt; access');
    await request(app).get('/api/mcp/auth/pending').query({ state: 'state-2' }).expect(404);
  });

  it('surfaces an OpenCode rejection as a failed page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid code' }), { status: 400 })));
    const { app } = createApp();
    await queuePending(app, { state: 'state-3', name: 'linear' });

    const response = await request(app)
      .get('/mcp/oauth/callback')
      .query({ state: 'state-3', code: 'stale-code' })
      .expect(502);

    expect(response.text).toContain('invalid code');
  });
});
