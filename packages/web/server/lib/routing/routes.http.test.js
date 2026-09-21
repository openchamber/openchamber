import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerRoutingPromptRewrite, registerRoutingRoutes } from './routes.js';

/**
 * The prompt rewrite sits in front of the generic OpenCode proxy, which
 * replays `req.body` when a middleware parsed it. These tests mount the
 * rewrite ahead of a stand-in proxy that records what it would forward.
 */
const createApp = ({ flag = '1', resolvePromptBody } = {}) => {
  process.env.OPENCHAMBER_ROUTING_ENABLE = flag;
  const forwarded = [];
  const runtime = {
    resolvePromptBody: resolvePromptBody ?? vi.fn(async (body) => {
      if (body.model?.modelID === 'auto') body.model = { providerID: 'openai', modelID: 'gpt-6-astra' };
      return null;
    }),
    describe: async () => ({ available: true, autoReady: true, tokenPresent: true, config: null, builtins: [] }),
    heldPermissions: () => [],
    updateConfig: vi.fn(async () => ({ available: true })),
    setToken: vi.fn(async () => ({ available: true, tokenPresent: true })),
    clearToken: vi.fn(async () => ({ available: true, tokenPresent: false })),
  };
  const app = express();
  registerRoutingRoutes(app, runtime);
  registerRoutingPromptRewrite(app, runtime);
  // Stand-in for the OpenCode proxy: a parsed body arrives as `req.body`, an
  // untouched stream arrives as raw bytes.
  app.use('/api', (req, res) => {
    if (req.body !== undefined) {
      forwarded.push({ path: req.path, parsed: true, body: req.body });
      return res.status(204).end();
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      forwarded.push({ path: req.path, parsed: false, raw });
      res.status(204).end();
    });
  });
  return { app, runtime, forwarded };
};

afterEach(() => {
  delete process.env.OPENCHAMBER_ROUTING_ENABLE;
});

describe('routing prompt rewrite', () => {
  it('rewrites the Auto sentinel on prompt_async and passes the directory along', async () => {
    const { app, runtime, forwarded } = createApp();
    await request(app)
      .post('/api/session/s1/prompt_async?directory=%2Frepo')
      .send({ model: { providerID: 'openchamber', modelID: 'auto' }, parts: [{ type: 'text', text: 'hi' }] })
      .expect(204);
    expect(forwarded).toEqual([{ path: '/session/s1/prompt_async', parsed: true, body: { model: { providerID: 'openai', modelID: 'gpt-6-astra' }, parts: [{ type: 'text', text: 'hi' }] } }]);
    expect(runtime.resolvePromptBody).toHaveBeenCalledWith(expect.anything(), { sessionId: 's1', directory: '/repo' });
  });

  it('leaves the stream untouched when the flag is off or the body is not JSON', async () => {
    const off = createApp({ flag: '' });
    await request(off.app).post('/api/session/s1/prompt').send({ model: { providerID: 'openchamber', modelID: 'auto' } }).expect(204);
    expect(off.forwarded[0].parsed).toBe(false);
    expect(off.runtime.resolvePromptBody).not.toHaveBeenCalled();

    const text = createApp();
    await request(text.app).post('/api/session/s1/command').set('content-type', 'text/plain').send('raw').expect(204);
    expect(text.forwarded[0]).toEqual({ path: '/session/s1/command', parsed: false, raw: 'raw' });
  });

  it('answers with the runtime error instead of forwarding an unresolved sentinel', async () => {
    const { app, forwarded } = createApp({
      resolvePromptBody: vi.fn(async () => { throw Object.assign(new Error('no fallback'), { status: 400 }); }),
    });
    const response = await request(app).post('/api/session/s1/prompt_async').send({ model: { providerID: 'openchamber', modelID: 'auto' } });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'no fallback' });
    expect(forwarded).toEqual([]);
  });
});

describe('routing routes', () => {
  it('serves state, saves config and manages the token', async () => {
    const { app, runtime } = createApp();
    const state = await request(app).get('/api/routing').expect(200);
    expect(state.body).toMatchObject({ available: true, autoReady: true, heldPermissions: [] });
    await request(app).put('/api/routing').send({ config: { enabled: true } }).expect(200);
    expect(runtime.updateConfig).toHaveBeenCalledWith({ enabled: true });
    await request(app).put('/api/routing/token').send({ token: 'ts-key' }).expect(200);
    expect(runtime.setToken).toHaveBeenCalledWith('ts-key');
    await request(app).delete('/api/routing/token').expect(200);
    expect(runtime.clearToken).toHaveBeenCalled();
  });

  it('is absent without the feature flag', async () => {
    const { app } = createApp({ flag: '' });
    await request(app).put('/api/routing/token').send({ token: 'x' }).expect(404);
  });
});
