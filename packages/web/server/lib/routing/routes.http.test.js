import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerRoutingPromptRewrite, registerRoutingRoutes } from './routes.js';
import { createRoutingRuntime } from './runtime.js';
import { resolveEffectiveConfig } from './store.js';
import { configureOpenCodeCredentials, openCodeCredentialSource } from '../opencode/auth.js';

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
    setClassifierSource: vi.fn(async () => ({ available: true })),
    setCustomEndpoint: vi.fn(async () => ({ available: true })),
    clearCustomEndpoint: vi.fn(async () => ({ available: true })),
    setGeminiKey: vi.fn(async () => ({ available: true, geminiKeyPresent: true })),
    clearGeminiKey: vi.fn(async () => ({ available: true, geminiKeyPresent: false })),
    testClassifier: vi.fn(async () => ({ ok: true })),
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

  it('decodes a URI-encoded directory header the way OpenCode reads it', async () => {
    const { app, runtime } = createApp({ autoSessions: new Set(['s1']) });
    await request(app)
      .post('/api/session/s1/prompt')
      .set('x-opencode-directory', '%2Frepo')
      .send({ text: 'hi' })
      .expect(204);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: '/repo', body: { text: 'hi' } });
  });

  it('decodes a directory header marked as URI-encoded', async () => {
    const { app, runtime } = createApp();
    await request(app)
      .post('/api/session/s1/model')
      .set('x-opencode-directory', '%2Frepo')
      .set('x-opencode-directory-encoding', 'uri')
      .send({ model: { providerID: 'openchamber', id: 'auto' } })
      .expect(204);
    expect(runtime.noteModelSelection).toHaveBeenCalledWith('s1', { providerID: 'openchamber', id: 'auto' }, '/repo');
  });

  it('forwards a directory header without percent-escapes untouched', async () => {
    const { app, runtime } = createApp({ autoSessions: new Set(['s1']) });
    await request(app)
      .post('/api/session/s1/prompt')
      .set('x-opencode-directory', '/repo')
      .send({ text: 'hi' })
      .expect(204);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: '/repo', body: { text: 'hi' } });
  });

  it('keeps a directory header with malformed escapes as it arrived', async () => {
    const { app, runtime } = createApp({ autoSessions: new Set(['s1']) });
    await request(app)
      .post('/api/session/s1/prompt')
      .set('x-opencode-directory', '%2Frepo%ZZ')
      .send({ text: 'hi' })
      .expect(204);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: '%2Frepo%ZZ', body: { text: 'hi' } });
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


  it('routes a form reply in a routed session onto the real model before forwarding the answer', async () => {
    const order = [];
    const { app, forwarded } = createApp({
      autoSessions: new Set(['s1']),
      routeSend: vi.fn(async () => { order.push(`switched with ${forwarded.length} forwarded`); }),
    });
    await request(app)
      .post('/api/session/s1/form/f1/reply?directory=%2Frepo')
      .send({ answer: { choice: 'ship it' } })
      .expect(204);
    expect(order).toEqual(['switched with 0 forwarded']);
    expect(forwarded).toEqual([{ path: '/session/s1/form/f1/reply', parsed: true, body: { answer: { choice: 'ship it' } } }]);
  });

  it('leaves a form unanswered when its reply cannot be routed', async () => {
    const { app, forwarded } = createApp({
      autoSessions: new Set(['s1']),
      routeSend: vi.fn(async () => { throw Object.assign(new Error('no fallback'), { status: 400 }); }),
    });
    const response = await request(app).post('/api/session/s1/form/f1/reply').send({ answer: { choice: 'ship it' } });
    expect(response.status).toBe(400);
    expect(forwarded).toEqual([]);
  });

  it('passes a form reply outside a routed session through as a stream', async () => {
    const { app, runtime, forwarded } = createApp();
    await request(app)
      .post('/api/session/global/form/f1/reply')
      .set('content-type', 'application/json')
      .send('{"answer":{"choice":"ok"}}')
      .expect(204);
    expect(runtime.routeSend).not.toHaveBeenCalled();
    expect(forwarded).toEqual([{ path: '/session/global/form/f1/reply', parsed: false, raw: '{"answer":{"choice":"ok"}}' }]);
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

  it.each([
    [],
    { text: 42, files: 'invalid', agent: false },
  ])('passes an unchecked JSON body through routing unchanged: %j', async (body) => {
    const { app, runtime, forwarded } = createApp({ autoSessions: new Set(['s1']) });
    await request(app).post('/api/session/s1/prompt').send(body).expect(204);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: undefined, body });
    expect(forwarded[0].body).toEqual(body);
  });

  it.each([
    [{ status: 409, message: false }, 409, false],
    [{ status: '400', message: 42 }, 500, 42],
    [null, 500, 'Routing request failed'],
  ])('preserves loose thrown error fields: %j', async (error, status, message) => {
    const { app, forwarded } = createApp({
      autoSessions: new Set(['s1']),
      routeSend: vi.fn(async () => { throw error; }),
    });
    const response = await request(app).post('/api/session/s1/prompt').send({ text: 'hi' });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: message });
    expect(forwarded).toEqual([]);
  });
});

describe('routing routes', () => {
  it('tests a native active OpenCode API key and stops reusing it when OpenCode changes its destination', async () => {
    const key = 'fictional-active-openai-api-key';
    const buildOpenCodeUrl = () => 'https://opencode.invalid/';
    const getOpenCodeAuthHeaders = () => ({});
    const provider = {
      id: 'openai', activation: 'auto', package: '@opencode/ai/providers/openai/responses',
      settings: { baseURL: 'https://api.openai.com/v1' },
    };
    const keyValue = { type: 'key', key };
    const oauthValue = { type: 'oauth', methodID: 'chatgpt-token-sharing', access: 'fictional-oauth', refresh: 'fictional-refresh', expires: 1 };
    const row = (id, active, value) => ({ id, active, value, label: id, integrationID: 'openai' });
    let active = keyValue;
    const sessionDirectory = '/fictional/session-project';
    const defaultDirectory = '/fictional/project';
    const catalogCalls = [];
    const openCodeFetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      const directoryHeader = request.headers.get('x-opencode-directory');
      switch (new URL(request.url).pathname) {
        case '/api/credential':
          return Response.json({ data: [row('cred_inactive', false, { type: 'key', key: 'unused-inactive-key' }), row('cred_active', true, active)] });
        case '/api/plugin':
          return Response.json({ data: [{ id: 'native' }] });
        case '/api/provider/openai':
          catalogCalls.push(directoryHeader);
          return Response.json({ data: provider });
        case '/api/config':
          catalogCalls.push(directoryHeader);
          return Response.json([
            { type: 'directory', path: directoryHeader ? decodeURIComponent(directoryHeader) : defaultDirectory },
            { type: 'document', info: directoryHeader === encodeURIComponent(sessionDirectory)
              ? { providers: { openai: { settings: { baseURL: 'https://gateway.invalid/v1' } } } }
              : {} },
          ]);
        case '/api/session/s1/model':
        case '/api/session/s2/model':
          return new Response(null, { status: 204 });
        default:
          throw new Error(`Unexpected request ${request.url}`);
      }
    });
    const classifierFetch = vi.fn(async () => Response.json({ answers: [{ type: 'choice', name: 'probe', choice: 'blue', confidence: 0.9 }] }));
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
    vi.stubGlobal('fetch', openCodeFetch);
    configureOpenCodeCredentials(openCodeCredentialSource({
      buildOpenCodeUrl, getOpenCodeAuthHeaders, getDefaultDirectory: () => defaultDirectory,
    }));
    try {
      const runtime = createRoutingRuntime({
        dataDir: '/unused',
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
        fetchImpl: classifierFetch,
        readProviderKeys: async () => ({}),
        readPinnedEndpoint: () => null,
        enterpriseMode: () => false,
        listCatalogModels: async () => [],
        readSessionAgent: async () => null,
        store: {
          readConfig: async () => ({
            ...resolveEffectiveConfig(null), enabled: true, fallback: { model: { providerID: 'fixture', modelID: 'fallback' }, variant: null },
          }),
          readToken: async () => null,
          readClassifierSource: async () => 'openai-decisions',
          readCustomEndpoint: async () => null,
          readGeminiKey: async () => null,
        },
      });
      const app = express();
      registerRoutingRoutes(app, runtime);
      registerRoutingPromptRewrite(app, runtime);
      app.use((_req, res) => res.sendStatus(204));
      const state = await request(app).get('/api/routing').expect(200);
      expect(state.body).toMatchObject({ openaiDecisionsStatus: 'ready', classification: { effective: 'openai-decisions' } });
      expect(state.text).not.toContain(key);
      await request(app).post('/api/routing/classifier/test').send({}).expect(200).expect(({ body }) => {
        expect(body).toMatchObject({ ok: true, source: 'openai-decisions', model: 'gpt-6-luna' });
      });
      expect(classifierFetch.mock.calls[0]).toEqual([
        'https://api.openai.com/v1/decisions',
        expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${key}` }) }),
      ]);
      expect(catalogCalls).toEqual(Array(4).fill(encodeURIComponent(defaultDirectory)));

      const model = { providerID: 'openchamber', id: 'auto' };
      catalogCalls.length = 0;
      await request(app).post('/api/session/s1/model').set('x-opencode-directory', encodeURIComponent(sessionDirectory)).send({ model }).expect(204);
      const sent = await request(app).post('/api/session/s1/prompt').send({ text: 'Synthetic request using a recorded project.' });
      expect(sent.status, JSON.stringify(sent.body)).toBe(204);
      expect(catalogCalls).toEqual(Array(2).fill(encodeURIComponent(sessionDirectory)));
      catalogCalls.length = 0;
      await request(app).post('/api/session/s2/model').send({ model }).expect(204);
      await request(app).post('/api/session/s2/prompt').send({ text: 'Synthetic request with no known project.' }).expect(204);
      expect(catalogCalls).toEqual([]);
      expect(classifierFetch).toHaveBeenCalledTimes(1);

      provider.settings.baseURL = 'https://gateway.invalid/v1';
      await request(app).post('/api/routing/classifier/test').send({}).expect(200, { ok: false, reason: 'unavailable' });
      provider.settings.baseURL = 'https://api.openai.com/v1';
      active = oauthValue;
      const oauth = await request(app).get('/api/routing').expect(200);
      expect(oauth.body).toMatchObject({ openaiDecisionsStatus: 'api_key_required', classification: { selected: 'openai-decisions', effective: null } });
      expect(classifierFetch).toHaveBeenCalledTimes(1);
      const upstreamCalls = openCodeFetch.mock.calls.length;
      const gatewayKey = 'fictional-gateway-bearer';
      vi.stubEnv('OPENAI_API_KEY', gatewayKey);
      vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.invalid/v1');
      const denied = await request(app).get('/api/routing').expect(200);
      expect(denied.body).toMatchObject({ openaiDecisionsStatus: 'api_key_required', classification: { effective: null } });
      expect(denied.text).not.toContain(gatewayKey);
      const probe = await request(app).post('/api/routing/classifier/test').send({}).expect(200, { ok: false, reason: 'unavailable' });
      expect(probe.text).not.toContain(gatewayKey);
      expect(openCodeFetch).toHaveBeenCalledTimes(upstreamCalls);
      expect(classifierFetch).toHaveBeenCalledTimes(1);
    } finally {
      configureOpenCodeCredentials(null);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('preserves the enterprise refusal code for direct OpenAI selection', async () => {
    const { app, runtime } = createApp();
    runtime.setClassifierSource.mockRejectedValueOnce(Object.assign(new Error('Blocked by policy'), {
      status: 403, code: 'enterprise_mode',
    }));
    await request(app).put('/api/routing/classifier').send({ source: 'openai-decisions' })
      .expect(403, { error: 'Blocked by policy', code: 'enterprise_mode' });
  });

  it('leaves input validation to the runtime', async () => {
    const { app, runtime } = createApp();
    await request(app).put('/api/routing/token').send({ token: false }).expect(200);
    expect(runtime.setToken).toHaveBeenCalledWith(false);
    await request(app).put('/api/routing/classifier').send({ source: [] }).expect(200);
    expect(runtime.setClassifierSource).toHaveBeenCalledWith([]);
    await request(app).put('/api/routing/classifier/custom').send({ url: 42, model: false }).expect(200);
    expect(runtime.setCustomEndpoint).toHaveBeenCalledWith({ url: 42, model: false, key: undefined });
    await request(app).post('/api/routing/classifier/test').send({ custom: 'invalid' }).expect(200);
    expect(runtime.testClassifier).toHaveBeenCalledWith({ url: undefined, model: undefined, key: undefined });
    await request(app).post('/api/routing/classifier/test').send({ custom: null }).expect(200);
    expect(runtime.testClassifier).toHaveBeenLastCalledWith(undefined);
  });

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
    await request(app).put('/api/routing/classifier').send({ source: 'zen-key' }).expect(200);
    expect(runtime.setClassifierSource).toHaveBeenCalledWith('zen-key');
    await request(app).put('/api/routing/classifier/custom').send({ url: 'https://jev.example.com/v1', model: 'jev-latest', key: 'k', extra: true }).expect(200);
    expect(runtime.setCustomEndpoint).toHaveBeenCalledWith({ url: 'https://jev.example.com/v1', model: 'jev-latest', key: 'k' });
    await request(app).delete('/api/routing/classifier/custom').expect(200);
    expect(runtime.clearCustomEndpoint).toHaveBeenCalled();
    await request(app).put('/api/routing/classifier/gemini').send({ key: 'g-key', extra: true }).expect(200);
    expect(runtime.setGeminiKey).toHaveBeenCalledWith('g-key');
    await request(app).delete('/api/routing/classifier/gemini').expect(200);
    expect(runtime.clearGeminiKey).toHaveBeenCalled();
  });

});
