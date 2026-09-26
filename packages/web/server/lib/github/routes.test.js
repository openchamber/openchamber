import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
  getOctokitOrNull: vi.fn(),
  getGitHubAuth: vi.fn(),
  resolveGitHubPrStatus: vi.fn(),
};

const { registerGitHubRoutes } = await import('./routes.js');

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(path, handler) { routes.set(`GET ${path}`, handler); },
      post(path, handler) { routes.set(`POST ${path}`, handler); },
      put(path, handler) { routes.set(`PUT ${path}`, handler); },
      delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
    },
    getRoute(method, path) { return routes.get(`${method} ${path}`); },
  };
};

const createRequest = (query) => Object.assign(new EventEmitter(), { query });

const createResponse = () => {
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    body: null,
  });
  response.status = function status(code) {
    response.statusCode = code;
    return response;
  };
  response.json = function json(body) {
    response.body = body;
    response.writableEnded = true;
    return response;
  };
  return response;
};

const resolvedStatus = {
  repo: { owner: 'owner', repo: 'project' },
  pr: { number: 7 },
  defaultBranch: 'main',
  resolvedRemoteName: 'origin',
};

describe('GitHub PR status route cancellation', () => {
  beforeEach(() => {
    mocks.getOctokitOrNull.mockReset();
    mocks.getGitHubAuth.mockReset();
    mocks.resolveGitHubPrStatus.mockReset();
    mocks.getGitHubAuth.mockReturnValue({ user: { login: 'me' } });
    mocks.resolveGitHubPrStatus.mockResolvedValue(resolvedStatus);
  });

  it('keeps the request listener through PR enrichment and signals every downstream call', async () => {
    const calls = {};
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn(async (options) => {
            calls.pull = options;
            return {
              data: {
                number: 7,
                title: 'Feature',
                state: 'open',
                head: { sha: 'abc123' },
                base: { ref: 'main' },
              },
            };
          }),
        },
        checks: {
          listForRef: vi.fn(async (options) => {
            calls.checks = options;
            return { data: { check_runs: [] } };
          }),
        },
        repos: {
          getCombinedStatusForRef: vi.fn(async (options) => {
            calls.combined = options;
            return { data: { statuses: [] } };
          }),
          getCollaboratorPermissionLevel: vi.fn(async (options) => {
            calls.permission = options;
            return { data: { permission: 'write' } };
          }),
        },
      },
    };
    mocks.getOctokitOrNull.mockReturnValue(octokit);

    const { app, getRoute } = createRouteRegistry();
    registerGitHubRoutes(app, {
      getGitHubLibraries: async () => mocks,
      resolveGitHubPrStatus: mocks.resolveGitHubPrStatus,
    });
    const response = createResponse();
    await getRoute('GET', '/api/github/pr/status')(
      createRequest({ directory: '/repo', branch: 'feature', force: 'true' }),
      response,
    );

    const signal = calls.pull.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(calls.checks.signal).toBe(signal);
    expect(calls.combined.signal).toBe(signal);
    expect(calls.permission.signal).toBe(signal);
    expect(response.body).toMatchObject({ connected: true, pr: { number: 7 }, canMerge: true });
  });

  it('aborts an enrichment request without removing the listener early', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = createRequest({ directory: '/repo', branch: 'cancelled', force: 'true' });
    const response = createResponse();
    let pullOptions;
    let rejectPull;
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn((options) => {
            pullOptions = options;
            return new Promise((_resolve, reject) => {
              rejectPull = reject;
              options.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
            });
          }),
        },
        checks: { listForRef: vi.fn() },
        repos: { getCombinedStatusForRef: vi.fn(), getCollaboratorPermissionLevel: vi.fn() },
      },
    };
    mocks.getOctokitOrNull.mockReturnValue(octokit);

    const { app, getRoute } = createRouteRegistry();
    registerGitHubRoutes(app, {
      getGitHubLibraries: async () => mocks,
      resolveGitHubPrStatus: mocks.resolveGitHubPrStatus,
    });
    const pending = getRoute('GET', '/api/github/pr/status')(request, response);
    for (let attempt = 0; attempt < 20 && !pullOptions; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(pullOptions?.signal).toBeInstanceOf(AbortSignal);

    request.emit('aborted');
    expect(pullOptions.signal.aborted).toBe(true);
    rejectPull?.(new Error('request aborted'));
    await pending;

    expect(response.body).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('aborts repository branch reads when the request disconnects', async () => {
    const request = createRequest({ owner: 'owner', repo: 'project' });
    const response = createResponse();
    let branchOptions;
    const octokit = {
      rest: {
        repos: {
          listBranches: vi.fn((options) => {
            branchOptions = options;
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
            });
          }),
        },
      },
    };
    mocks.getOctokitOrNull.mockReturnValue(octokit);

    const { app, getRoute } = createRouteRegistry();
    registerGitHubRoutes(app, { getGitHubLibraries: async () => mocks });
    const pending = getRoute('GET', '/api/github/repo/branches')(request, response);
    for (let attempt = 0; attempt < 20 && !branchOptions; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(branchOptions?.signal).toBeInstanceOf(AbortSignal);

    request.emit('aborted');
    expect(branchOptions.signal.aborted).toBe(true);
    await pending;
    expect(response.body).toBeNull();
  });

  it('shares authenticated-user lookup across PR-status waiters without sharing cancellation', async () => {
    mocks.getGitHubAuth.mockReturnValue({});
    let resolveUser;
    let userSignal;
    const getAuthenticated = vi.fn((options) => {
      userSignal = options.signal;
      return new Promise((resolve) => { resolveUser = resolve; });
    });
    const octokit = {
      rest: {
        users: { getAuthenticated },
        pulls: {
          get: vi.fn(async () => ({ data: { number: 7, state: 'open', head: {}, base: {} } })),
        },
        repos: {
          getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: 'write' } })),
        },
      },
    };
    mocks.getOctokitOrNull.mockReturnValue(octokit);

    const { app, getRoute } = createRouteRegistry();
    registerGitHubRoutes(app, {
      getGitHubLibraries: async () => mocks,
      resolveGitHubPrStatus: mocks.resolveGitHubPrStatus,
    });
    const handler = getRoute('GET', '/api/github/pr/status');
    const firstRequest = createRequest({ directory: '/repo', branch: 'first', force: 'true' });
    const secondRequest = createRequest({ directory: '/repo', branch: 'second', force: 'true' });
    const firstResponse = createResponse();
    const secondResponse = createResponse();
    const first = handler(firstRequest, firstResponse);
    const second = handler(secondRequest, secondResponse);

    for (let attempt = 0; attempt < 20 && !userSignal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
    firstRequest.emit('aborted');
    await first;
    expect(firstResponse.body).toBeNull();
    expect(userSignal.aborted).toBe(false);

    resolveUser({ data: { login: 'me' } });
    await second;
    expect(secondResponse.body).toMatchObject({ connected: true, canMerge: true });
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('does not let an aborted auth source clear a newer PR-status generation', async () => {
    mocks.getGitHubAuth.mockReturnValue({});
    const userRequests = [];
    const octokit = {
      rest: {
        users: {
          getAuthenticated: vi.fn((options) => new Promise((resolve, reject) => {
            userRequests.push({ options, resolve, reject });
          })),
        },
        pulls: {
          get: vi.fn(async () => ({ data: { number: 7, state: 'open', head: {}, base: {} } })),
        },
        repos: {
          getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: 'write' } })),
        },
      },
    };
    mocks.getOctokitOrNull.mockReturnValue(octokit);

    const { app, getRoute } = createRouteRegistry();
    registerGitHubRoutes(app, {
      getGitHubLibraries: async () => mocks,
      resolveGitHubPrStatus: mocks.resolveGitHubPrStatus,
    });
    const handler = getRoute('GET', '/api/github/pr/status');
    const firstRequest = createRequest({ directory: '/repo', branch: 'first', force: 'true' });
    const firstResponse = createResponse();
    const first = handler(firstRequest, firstResponse);
    for (let attempt = 0; attempt < 20 && userRequests.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    firstRequest.emit('aborted');
    await first;
    expect(userRequests[0].options.signal.aborted).toBe(true);

    const secondRequest = createRequest({ directory: '/repo', branch: 'second', force: 'true' });
    const secondResponse = createResponse();
    const second = handler(secondRequest, secondResponse);
    for (let attempt = 0; attempt < 20 && userRequests.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(userRequests).toHaveLength(2);

    userRequests[0].reject(new Error('stale source finished after reset'));
    const thirdRequest = createRequest({ directory: '/repo', branch: 'third', force: 'true' });
    const thirdResponse = createResponse();
    const third = handler(thirdRequest, thirdResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(userRequests).toHaveLength(2);

    userRequests[1].resolve({ data: { login: 'me' } });
    await Promise.all([second, third]);
    expect(secondResponse.body).toMatchObject({ connected: true, canMerge: true });
    expect(thirdResponse.body).toMatchObject({ connected: true, canMerge: true });
  });
});
