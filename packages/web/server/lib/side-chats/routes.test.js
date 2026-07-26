import { describe, expect, it, vi } from 'vitest';

import { registerSideChatRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      post(path, handler) {
        routes.set(`POST ${path}`, handler);
      },
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createResponse = () => {
  let statusCode = 200;
  let body;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const createHarness = (fetchImpl = vi.fn(), overrides = {}) => {
  const { app, getRoute } = createRouteRegistry();
  const resolveProjectDirectory = vi.fn(async () => ({ directory: '/repo/app', error: null }));
  registerSideChatRoutes(app, {
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer upstream-token' }),
    resolveProjectDirectory,
    fetch: fetchImpl,
    requestTimeoutMs: 25,
    ...overrides,
  });
  return { getRoute, resolveProjectDirectory, fetchImpl };
};

const sideChatRequest = (body, overrides = {}) => ({
  body,
  query: {},
  get: () => null,
  ...overrides,
});

describe('side chat routes', () => {
  it('creates a fork at the requested completed message and marks it disposable', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: 'ses_side', metadata: { custom: { value: 'kept' } } }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'ses_side',
        metadata: {
          custom: { value: 'kept' },
          openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } },
        },
      }))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'ses_side',
        metadata: {
          custom: { value: 'kept' },
          openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } },
        },
      }]));
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();

    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest(
      { parentSessionID: 'ses_parent', messageID: 'msg_complete' },
      { query: { directory: '/repo/app' } },
    ), response);

    expect(response.statusCode).toBe(201);
    expect(response.body.id).toBe('ses_side');
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://opencode.test/session/ses_parent/fork?directory=%2Frepo%2Fapp', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer upstream-token' }),
      body: JSON.stringify({ messageID: 'msg_complete' }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'http://opencode.test/session/ses_side?directory=%2Frepo%2Fapp', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        metadata: {
          custom: { value: 'kept' },
          openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } },
        },
      }),
    }));
  });

  it.each([
    [{ messageID: 'msg_complete' }, 'parentSessionID is required'],
    [{ parentSessionID: 'ses_parent' }, 'messageID is required'],
  ])('rejects invalid identity %#', async (body, error) => {
    const fetchImpl = vi.fn();
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();

    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest(body), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a disallowed request origin before touching OpenCode', async () => {
    const fetchImpl = vi.fn();
    const { getRoute } = createHarness(fetchImpl, { isRequestOriginAllowed: async () => false });
    const response = createResponse();
    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent', messageID: 'msg_complete',
    }), response);
    expect(response.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards an upstream fork failure without attempting metadata or cleanup', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ error: 'fork failed' }, 502));
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();

    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent',
      messageID: 'msg_complete',
    }), response);

    expect(response.statusCode).toBe(502);
    expect(response.body).toEqual({ error: 'fork failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('deletes the fork when marking fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: 'ses_side', metadata: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: 'marker failed' }, 500))
      .mockResolvedValueOnce(jsonResponse(true));
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();

    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent',
      messageID: 'msg_complete',
    }), response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'marker failed' });
    expect(fetchImpl).toHaveBeenNthCalledWith(4, 'http://opencode.test/session/ses_side?directory=%2Frepo%2Fapp', expect.objectContaining({ method: 'DELETE' }));
  });

  it('surfaces cleanup failure distinctly when marking fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: 'ses_side', metadata: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: 'marker failed' }, 500))
      .mockResolvedValueOnce(jsonResponse({ error: 'delete failed' }, 503));
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();

    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent',
      messageID: 'msg_complete',
    }), response);

    expect(response.statusCode).toBe(502);
    expect(response.body).toEqual({
      error: 'Failed to mark disposable side chat and delete the fork',
      forkSessionID: 'ses_side',
      markerError: 'marker failed',
      cleanupError: 'delete failed',
      cleanupRequired: true,
    });
  });

  it('does not treat an unsuccessful delete result as authoritative cleanup', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: 'ses_side', metadata: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: 'marker failed' }, 500))
      .mockResolvedValueOnce(jsonResponse(false));
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();

    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent',
      messageID: 'msg_complete',
    }), response);

    expect(response.statusCode).toBe(502);
    expect(response.body).toMatchObject({
      error: 'Failed to mark disposable side chat and delete the fork',
      forkSessionID: 'ses_side',
      cleanupError: 'OpenCode did not confirm fork deletion',
    });
  });

  it('promotes idempotently while preserving unrelated metadata and forwarding directory/auth', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'ses_side',
        metadata: {
          custom: { value: 'kept' },
          openchamber: {
            goal: { id: 'goal_1' },
            sideChat: { disposable: true, parentSessionID: 'ses_parent' },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'ses_side',
        metadata: { custom: { value: 'kept' }, openchamber: { goal: { id: 'goal_1' } } },
      }));
    const { getRoute } = createHarness(fetchImpl);
    const request = {
      body: {},
      params: { sessionId: 'ses_side' },
      query: { directory: '/repo/app' },
      get: () => null,
    };
    const response = createResponse();

    await getRoute('POST', '/api/openchamber/side-chats/:sessionId/promote')(request, response);

    expect(response.body.metadata).toEqual({ custom: { value: 'kept' }, openchamber: { goal: { id: 'goal_1' } } });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://opencode.test/session/ses_side?directory=%2Frepo%2Fapp', expect.objectContaining({
      method: 'PATCH',
      headers: expect.objectContaining({ Authorization: 'Bearer upstream-token' }),
      body: JSON.stringify({ metadata: { custom: { value: 'kept' }, openchamber: { goal: { id: 'goal_1' } } } }),
    }));

    fetchImpl.mockClear();
    fetchImpl.mockResolvedValueOnce(jsonResponse(response.body));
    const repeatedResponse = createResponse();
    await getRoute('POST', '/api/openchamber/side-chats/:sessionId/promote')(request, repeatedResponse);

    expect(repeatedResponse.body).toEqual(response.body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts the encoded directory header through the shared directory resolver', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: 'ses_side', metadata: {} }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'ses_side',
        metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } },
      }))
      .mockResolvedValueOnce(jsonResponse([{
        id: 'ses_side',
        metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } },
      }]));
    const { getRoute, resolveProjectDirectory } = createHarness(fetchImpl);
    const response = createResponse();
    const request = sideChatRequest(
      { parentSessionID: 'ses_parent', messageID: 'msg_complete' },
      {
        get: (name) => name === 'x-opencode-directory'
          ? encodeURIComponent('/repo/app with space')
          : name === 'x-opencode-directory-encoding' ? 'uri' : null,
      },
    );

    await getRoute('POST', '/api/openchamber/side-chats')(request, response);

    expect(resolveProjectDirectory).toHaveBeenCalledWith(request);
    expect(response.statusCode).toBe(201);
  });

  it('rejects a malformed successful marker response and retains cleanup ownership when deletion fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: 'ses_side', metadata: {} }))
      .mockResolvedValueOnce(jsonResponse({ id: 'wrong', metadata: {} }))
      .mockResolvedValueOnce(jsonResponse(false));
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();

    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent', messageID: 'msg_complete',
    }), response);

    expect(response.statusCode).toBe(502);
    expect(response.body).toMatchObject({
      cleanupRequired: true,
      forkSessionID: 'ses_side',
      markerError: 'OpenCode returned an invalid marked side chat',
    });
  });

  it('serializes concurrent creates per parent and reuses the marked session', async () => {
    let releaseFork;
    const forkPending = new Promise((resolve) => { releaseFork = resolve; });
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).includes('/session?')) {
        const marked = fetchImpl.mock.calls.some(([, request]) => request.method === 'PATCH');
        return jsonResponse(marked ? [{
          id: 'ses_side', metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } },
        }] : []);
      }
      if (String(url).includes('/fork')) {
        await forkPending;
        return jsonResponse({ id: 'ses_side', metadata: {} });
      }
      if (init.method === 'PATCH') return jsonResponse({
        id: 'ses_side',
        metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } },
      });
      throw new Error(`unexpected request ${url}`);
    });
    const { getRoute } = createHarness(fetchImpl);
    const handler = getRoute('POST', '/api/openchamber/side-chats');
    const firstResponse = createResponse();
    const secondResponse = createResponse();
    const request = sideChatRequest({ parentSessionID: 'ses_parent', messageID: 'msg_complete' });
    const first = handler(request, firstResponse);
    const second = handler(request, secondResponse);
    releaseFork();
    await Promise.all([first, second]);

    expect(firstResponse.body.id).toBe('ses_side');
    expect(secondResponse.body.id).toBe('ses_side');
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/fork'))).toHaveLength(1);
  });

  it('reuses an existing marked session without forking', async () => {
    const marked = {
      id: 'ses_existing',
      metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse([marked]));
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();
    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent', messageID: 'msg_complete',
    }), response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(marked);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('deterministically retains one marked fork and deletes duplicates before responding', async () => {
    const second = { id: 'ses_b', metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } } };
    const first = { id: 'ses_a', metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([second, first]))
      .mockResolvedValueOnce(jsonResponse(true));
    const { getRoute } = createHarness(fetchImpl);
    const response = createResponse();
    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent', messageID: 'msg_complete',
    }), response);
    expect(response.body.id).toBe('ses_a');
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://opencode.test/session/ses_b?directory=%2Frepo%2Fapp', expect.objectContaining({ method: 'DELETE' }));
  });

  it('continues the per-parent queue after a rejected create', async () => {
    const marked = { id: 'ses_existing', metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } } };
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('inspection failed'))
      .mockResolvedValueOnce(jsonResponse([marked]));
    const { getRoute } = createHarness(fetchImpl);
    const handler = getRoute('POST', '/api/openchamber/side-chats');
    const firstResponse = createResponse();
    const secondResponse = createResponse();
    await handler(sideChatRequest({ parentSessionID: 'ses_parent', messageID: 'msg_complete' }), firstResponse);
    await handler(sideChatRequest({ parentSessionID: 'ses_parent', messageID: 'msg_complete' }), secondResponse);
    expect(firstResponse.statusCode).toBe(502);
    expect(secondResponse.body).toEqual(marked);
  });

  it('times out an upstream request with a non-empty error', async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const { getRoute } = createHarness(fetchImpl, { requestTimeoutMs: 1 });
    const response = createResponse();
    await getRoute('POST', '/api/openchamber/side-chats')(sideChatRequest({
      parentSessionID: 'ses_parent', messageID: 'msg_complete',
    }), response);
    expect(response.statusCode).toBe(504);
    expect(response.body.error).toBeTruthy();
  });
});
