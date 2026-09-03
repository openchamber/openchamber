import { OpenCode } from '@opencode-ai/client';
import { describe, expect, it, vi } from 'vitest';

import {
  UnsupportedOpenCodeOperationError,
  createOpenCodeApiRuntime,
} from './api-runtime.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});

const v2Session = (id, parentID) => ({
  id,
  ...(parentID ? { parentID } : {}),
  projectID: 'project-1',
  agent: 'build',
  model: { providerID: 'provider-1', id: 'model-1', variant: 'high' },
  cost: 1,
  tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
  time: { created: 10, updated: 20 },
  title: `Session ${id}`,
  location: { directory: '/repo' },
});

const createV2Runtime = (fetchImpl, overrides = {}) => createOpenCodeApiRuntime({
  getOpenCodeProtocol: () => 'opencode2',
  buildOpenCodeUrl: () => overrides.baseUrl ?? 'https://opencode.test/',
  getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
  createV2Client: (options) => OpenCode.make({ ...options, fetch: fetchImpl }),
});

describe('OpenCode API runtime', () => {
  it('uses the generated V2 client with auth, location, response envelopes, and 204 mutations', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/session' && request.method === 'POST') return json({ data: v2Session('created') });
      if (path.endsWith('/agent')) return new Response(null, { status: 204 });
      if (path.endsWith('/model')) return new Response(null, { status: 204 });
      if (path.endsWith('/prompt')) {
        return json({ data: { id: 'inbox-1', sessionID: 'created', timeCreated: 1, type: 'user', payload: { text: 'hello' }, delivery: 'steer' } });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    });
    const runtime = createV2Runtime(fetchImpl);

    const session = await runtime.createSession({
      directory: '/repo',
      title: 'Created',
      agent: 'build',
      model: { providerID: 'provider-1', modelID: 'model-1' },
    });
    await runtime.sendPrompt({
      sessionID: session.id,
      directory: '/repo',
      agent: 'review',
      parts: [{ type: 'text', text: 'hello' }],
    });

    expect(session).toMatchObject({ id: 'created', directory: '/repo', model: { modelID: 'model-1' } });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'POST /api/session',
      'POST /api/session/created/agent',
      'POST /api/session/created/prompt',
    ]);
    expect(requests.every((request) => request.headers.get('authorization') === 'Basic test')).toBe(true);
    expect(await requests[0].json()).toEqual({
      title: 'Created',
      agent: 'build',
      model: { id: 'model-1', providerID: 'provider-1' },
      location: { directory: '/repo' },
    });
    expect(await requests[2].json()).toEqual({ text: 'hello' });
  });

  it('keeps synthetic context separate from the user prompt', async () => {
    const bodies = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const request = new Request(url, init);
      bodies.push({ path: new URL(request.url).pathname, body: await request.json() });
      if (request.url.endsWith('/synthetic')) {
        return json({ data: { id: 'synthetic-1', sessionID: 'session-1', timeCreated: 1, type: 'synthetic', payload: { text: 'context' }, delivery: 'queue' } });
      }
      return json({ data: { id: 'prompt-1', sessionID: 'session-1', timeCreated: 2, type: 'user', payload: { text: 'question' }, delivery: 'steer' } });
    });
    const runtime = createV2Runtime(fetchImpl);

    await runtime.sendPrompt({
      sessionID: 'session-1',
      directory: '/repo',
      parts: [
        { type: 'text', text: 'context', synthetic: true },
        { type: 'text', text: 'question' },
      ],
    });

    expect(bodies).toEqual([
      {
        path: '/api/session/session-1/synthetic',
        body: { text: 'context', delivery: 'queue', resume: false },
      },
      { path: '/api/session/session-1/prompt', body: { text: 'question' } },
    ]);
  });

  it('normalizes V2 message pages without losing cursor or user-assistant lineage', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/session/session-1') return json({ data: v2Session('session-1') });
      return json({
        data: [
          {
            id: 'assistant-1',
            type: 'assistant',
            time: { created: 2, completed: 3 },
            agent: 'build',
            model: { providerID: 'provider-1', id: 'model-1' },
            content: [{ type: 'text', text: 'answer' }],
            finish: 'stop',
          },
          { id: 'user-1', type: 'user', time: { created: 1 }, text: 'question' },
        ],
        cursor: { next: 'older-1' },
      });
    });
    const runtime = createV2Runtime(fetchImpl);

    const result = await runtime.listMessages({ sessionID: 'session-1', directory: '/repo', limit: 20 });

    expect(result.cursor).toBe('older-1');
    expect(result.messages).toEqual([
      expect.objectContaining({ info: expect.objectContaining({ id: 'user-1', role: 'user' }) }),
      expect.objectContaining({
        info: expect.objectContaining({ id: 'assistant-1', role: 'assistant', parentID: 'user-1', finish: 'stop' }),
        parts: [expect.objectContaining({ type: 'text', text: 'answer' })],
      }),
    ]);
  });

  it('distinguishes active, unknown, and unavailable V2 status', async () => {
    let mode = 'active';
    const fetchImpl = vi.fn(async () => {
      if (mode === 'failure') throw new Error('offline');
      return json({ data: mode === 'active' ? { 'session-1': { type: 'running' } } : {} });
    });
    const runtime = createV2Runtime(fetchImpl);

    await expect(runtime.getSessionStatus('session-1', '/repo')).resolves.toEqual({
      kind: 'authoritative',
      status: { type: 'busy' },
    });
    mode = 'empty';
    await expect(runtime.getSessionStatus('session-1', '/repo')).resolves.toEqual({ kind: 'unknown' });
    mode = 'failure';
    const unavailable = await runtime.getSessionStatus('session-1', '/repo');
    expect(unavailable.kind).toBe('unavailable');
    expect(unavailable.error).toBeInstanceOf(Error);
  });

  it('uses generated V2 permission list and reply operations', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/api/permission/request') {
        return json({
          location: { directory: '/repo', project: { id: 'project-1', directory: '/repo', canonical: '/repo' } },
          data: [{ id: 'permission-1', sessionID: 'session-1', action: 'read', resources: ['*'], metadata: {} }],
        });
      }
      if (path === '/api/session/session-1/permission/permission-1/reply') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    });
    const runtime = createV2Runtime(fetchImpl);

    await expect(runtime.listPendingPermissions('/repo')).resolves.toEqual([
      expect.objectContaining({ id: 'permission-1', sessionID: 'session-1' }),
    ]);
    await expect(runtime.replyPermission({
      sessionID: 'session-1',
      requestID: 'permission-1',
      directory: '/repo',
      reply: 'once',
    })).resolves.toBe(true);

    const listUrl = new URL(requests[0].url);
    expect(listUrl.searchParams.get('location[directory]')).toBe('/repo');
    expect(await requests[1].json()).toEqual({ reply: 'once' });
    expect(requests.every((request) => request.headers.get('authorization') === 'Basic test')).toBe(true);
  });

  it('paginates V2 roots and descendants with the caller abort signal', async () => {
    const calls = [];
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url, init) => {
      const request = new Request(url, init);
      const parsed = new URL(request.url);
      const parentID = parsed.searchParams.get('parentID');
      const cursor = parsed.searchParams.get('cursor');
      calls.push({ parentID, cursor, signal: init?.signal });
      if (parentID === 'null' && cursor === null) {
        return json({ data: [v2Session('root-1')], cursor: { next: 'root-page-2' } });
      }
      if (parentID === 'null' && cursor === 'root-page-2') {
        return json({ data: [v2Session('root-2')], cursor: {} });
      }
      if (parentID === 'root-1') {
        return json({ data: [v2Session('child-1', 'root-1')], cursor: {} });
      }
      return json({ data: [], cursor: {} });
    });
    const runtime = createV2Runtime(fetchImpl);

    const result = await runtime.listSessions({
      directory: '/repo',
      roots: false,
      allPages: true,
      limit: 10,
    }, { signal: controller.signal });

    expect(result.sessions.map((session) => session.id)).toEqual(['root-1', 'root-2', 'child-1']);
    expect(result.cursor).toBe(undefined);
    expect(calls.map(({ parentID, cursor }) => ({ parentID, cursor }))).toEqual([
      { parentID: 'null', cursor: null },
      { parentID: 'null', cursor: 'root-page-2' },
      { parentID: 'root-1', cursor: null },
      { parentID: 'root-2', cursor: null },
      { parentID: 'child-1', cursor: null },
    ]);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it('fails unsupported V2 operations before issuing a request', async () => {
    const fetchImpl = vi.fn(async () => json({}));
    const runtime = createV2Runtime(fetchImpl);

    await expect(runtime.mergeSessionMetadata('session-1', '/repo', () => ({ pinned: true })))
      .rejects.toBeInstanceOf(UnsupportedOpenCodeOperationError);
    await expect(runtime.getRuntimeProviderListing())
      .rejects.toBeInstanceOf(UnsupportedOpenCodeOperationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fresh-reads and merges legacy metadata while propagating SDK errors', async () => {
    const sdkError = new Error('legacy failure');
    const update = vi.fn(async () => ({ data: { id: 'session-1' } }));
    const listProviders = vi.fn(async () => ({ data: { all: [], connected: [], default: {} } }));
    const legacy = {
      session: {
        get: vi.fn(async () => ({ data: { id: 'session-1', metadata: { other: true } } })),
        update,
        list: vi.fn(async () => ({ error: sdkError })),
      },
      provider: { list: listProviders },
    };
    const runtime = createOpenCodeApiRuntime({
      getOpenCodeProtocol: () => 'legacy',
      buildOpenCodeUrl: () => 'https://legacy.test/',
      getOpenCodeAuthHeaders: () => ({}),
      createLegacyClient: () => legacy,
    });

    const metadata = await runtime.mergeSessionMetadata('session-1', '/repo', (current) => ({ ...current, added: true }));
    expect(metadata).toEqual({ other: true, added: true });
    expect(update).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: '/repo',
      metadata: { other: true, added: true },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await expect(runtime.getRuntimeProviderListing('/repo')).resolves.toEqual({ all: [], connected: [], default: {} });
    expect(listProviders).toHaveBeenCalledWith({ directory: '/repo' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await expect(runtime.listSessions({ directory: '/repo' })).rejects.toBe(sdkError);
  });

  it('resolves URL, auth, and protocol at call time', async () => {
    let baseUrl = 'https://one.test/';
    let token = 'one';
    const requests = [];
    const runtime = createOpenCodeApiRuntime({
      getOpenCodeProtocol: () => 'opencode2',
      buildOpenCodeUrl: () => baseUrl,
      getOpenCodeAuthHeaders: () => ({ authorization: token }),
      createV2Client: (options) => OpenCode.make({
        ...options,
        fetch: async (url, init) => {
          const request = new Request(url, init);
          requests.push({ url: request.url, token: request.headers.get('authorization') });
          return json({ data: v2Session('session-1') });
        },
      }),
    });

    await runtime.getSession('session-1', '/repo');
    baseUrl = 'https://two.test/';
    token = 'two';
    await runtime.getSession('session-1', '/repo');

    expect(requests).toEqual([
      { url: 'https://one.test/api/session/session-1', token: 'one' },
      { url: 'https://two.test/api/session/session-1', token: 'two' },
    ]);
  });
});
