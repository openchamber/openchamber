import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitLibraries = {
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  createWorktree: vi.fn(),
  getWorktreeBootstrapStatus: vi.fn(),
};

vi.mock('./index.js', () => ({
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  createWorktree: gitLibraries.createWorktree,
  getWorktreeBootstrapStatus: gitLibraries.getWorktreeBootstrapStatus,
}));

const { registerGitRoutes } = await import('./routes.js');

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
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

describe('git routes index mutations', () => {
  beforeEach(() => {
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
    gitLibraries.createWorktree.mockReset();
    gitLibraries.getWorktreeBootstrapStatus.mockReset();
  });

  it('accepts legacy stage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads before calling git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: [' ', null] } },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path parameter is required' });
    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
  });
});

describe('git routes linked worktree failures', () => {
  beforeEach(() => {
    gitLibraries.createWorktree.mockReset();
    gitLibraries.getWorktreeBootstrapStatus.mockReset();
  });

  it('preserves the structured pull-request source code in create errors', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();
    gitLibraries.createWorktree.mockRejectedValue(Object.assign(
      new Error('pull_request_unavailable'),
      { code: 'pull_request_unavailable' },
    ));

    await getRoute('POST', '/api/git/worktrees')(
      { query: { directory: '/repo' }, body: { worktreeName: 'pr-race' } },
      response,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: 'pull_request_unavailable',
      code: 'pull_request_unavailable',
    });
  });

  it('preserves the structured pull-request source code in bootstrap status', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();
    gitLibraries.getWorktreeBootstrapStatus.mockResolvedValue({
      status: 'failed',
      phase: 'directory-created',
      error: 'pull_request_unavailable',
      code: 'pull_request_unavailable',
      updatedAt: 1,
    });

    await getRoute('GET', '/api/git/worktrees/bootstrap-status')(
      { query: { directory: '/repo-pr-race' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'failed',
      code: 'pull_request_unavailable',
    });
  });
});
