import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerRoutingPromptRewrite, registerRoutingRoutes } from './routes.js';

/**
 * The send rewrite sits in front of the generic OpenCode proxy, which replays
 * `req.body` when a middleware parsed it. These tests mount the rewrite ahead
 * of a stand-in proxy that records what it would forward.
 */
const createApp = ({ routeSend, autoSessions = new Set() } = {}) => {
  const forwarded = [];
  const runtime = {
    noteModelSelection: vi.fn((sessionId, model) => {
      const auto = model?.providerID === 'openchamber' && model?.id === 'auto';
      if (auto) autoSessions.add(sessionId);
      else autoSessions.delete(sessionId);
      return auto;
    }),
    isAutoSession: (sessionId) => autoSessions.has(sessionId),
    routeSend: routeSend ?? vi.fn(async ({ body }) => {
      if (typeof body?.command === 'string') body.model = { providerID: 'openai', id: 'gpt-6-astra' };
      return {};
    }),
    describe: async () => ({ available: true, autoReady: true, tokenPresent: true, jevSource: 'typesafe', config: null, builtins: [] }),
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

describe('routing send rewrite', () => {
  it('swallows the Auto sentinel on a model switch instead of forwarding it', async () => {
    const { app, runtime, forwarded } = createApp();
    await request(app)
      .post('/api/session/s1/model?directory=%2Frepo')
      .send({ model: { providerID: 'openchamber', id: 'auto' } })
      .expect(204);
    expect(forwarded).toEqual([]);
    expect(runtime.noteModelSelection).toHaveBeenCalledWith('s1', { providerID: 'openchamber', id: 'auto' }, '/repo');
    expect(runtime.isAutoSession('s1')).toBe(true);
  });

  it('drops the Auto sentinel from a session create so OpenCode never stores it', async () => {
    const { app, forwarded, runtime } = createApp();
    await request(app)
      .post('/api/session?directory=%2Frepo')
      .send({ title: 'btw', model: { providerID: 'openchamber', id: 'auto' }, agent: 'build' })
      .expect(204);
    expect(forwarded).toEqual([{ path: '/session', parsed: true, body: { title: 'btw', agent: 'build' } }]);
    expect(runtime.noteModelSelection).not.toHaveBeenCalled();

    await request(app).post('/api/session').send({ model: { providerID: 'anthropic', id: 'claude-opus-5' } }).expect(204);
    expect(forwarded[1]).toEqual({ path: '/session', parsed: true, body: { model: { providerID: 'anthropic', id: 'claude-opus-5' } } });
  });

  it('forwards a real model switch untouched and takes the session off Auto', async () => {
    const { app, forwarded, runtime } = createApp();
    await request(app).post('/api/session/s1/model').send({ model: { providerID: 'openchamber', id: 'auto' } }).expect(204);
    await request(app).post('/api/session/s1/model').send({ model: { providerID: 'anthropic', id: 'claude-opus-5' } }).expect(204);
    expect(forwarded).toEqual([{ path: '/session/s1/model', parsed: true, body: { model: { providerID: 'anthropic', id: 'claude-opus-5' } } }]);
    expect(runtime.isAutoSession('s1')).toBe(false);
  });

  it('routes a prompt in an Auto session and passes the directory along', async () => {
    const autoSessions = new Set(['s1']);
    const { app, runtime, forwarded } = createApp({ autoSessions });
    await request(app)
      .post('/api/session/s1/prompt?directory=%2Frepo')
      .send({ text: 'hi' })
      .expect(204);
    expect(forwarded).toEqual([{ path: '/session/s1/prompt', parsed: true, body: { text: 'hi' } }]);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: '/repo', body: { text: 'hi' } });
  });

  it('leaves a send in a session that is not on Auto unread', async () => {
    const { app, runtime, forwarded } = createApp();
    await request(app).post('/api/session/s1/prompt').send({ text: 'hi' }).expect(204);
    expect(runtime.routeSend).not.toHaveBeenCalled();
    expect(forwarded[0].parsed).toBe(false);
  });

  it('leaves the stream untouched when the body is not JSON', async () => {
    const text = createApp({ autoSessions: new Set(['s1']) });
    await request(text.app).post('/api/session/s1/command').set('content-type', 'text/plain').send('raw').expect(204);
    expect(text.forwarded[0]).toEqual({ path: '/session/s1/command', parsed: false, raw: 'raw' });
  });


  it('answers with the runtime error instead of forwarding an unroutable send', async () => {
    const { app, forwarded } = createApp({
      autoSessions: new Set(['s1']),
      routeSend: vi.fn(async () => { throw Object.assign(new Error('no fallback'), { status: 400 }); }),
    });
    const response = await request(app).post('/api/session/s1/prompt').send({ text: 'hi' });
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

});
