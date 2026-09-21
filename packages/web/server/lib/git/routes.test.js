import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitLibraries = {
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  getWorktrees: vi.fn(),
  observeWorktreeTopology: vi.fn(),
  subscribeWorktreeTopologyChanges: vi.fn(),
  removeWorktree: vi.fn(),
};

vi.mock('./index.js', () => ({
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  isGitRepository: gitLibraries.isGitRepository,
  getStatus: gitLibraries.getStatus,
  getWorktrees: gitLibraries.getWorktrees,
  observeWorktreeTopology: gitLibraries.observeWorktreeTopology,
  subscribeWorktreeTopologyChanges: gitLibraries.subscribeWorktreeTopologyChanges,
  removeWorktree: gitLibraries.removeWorktree,
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
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
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

describe('git worktree topology routes', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.getWorktrees.mockReset();
    gitLibraries.observeWorktreeTopology.mockReset();
    gitLibraries.subscribeWorktreeTopologyChanges.mockReset();
    gitLibraries.observeWorktreeTopology.mockResolvedValue(undefined);
  });

  it('observes the repository topology while serving status, never for non-repositories', async () => {
    gitLibraries.isGitRepository.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    gitLibraries.getStatus.mockResolvedValue({ current: 'main' });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const route = getRoute('GET', '/api/git/status');

    const repoResponse = createMockResponse();
    await route({ query: { directory: '/repo' } }, repoResponse);
    expect(repoResponse.body).toEqual({ current: 'main' });
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledWith('/repo');

    await route({ query: { directory: '/plain-folder' } }, createMockResponse());
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledTimes(1);
  });

  it('observes topology after a repository listing and reports listing failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gitLibraries.getWorktrees
      .mockResolvedValueOnce([{ path: '/repo', branch: 'main' }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('git failed'));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const route = getRoute('GET', '/api/git/worktrees');

    const listed = createMockResponse();
    await route({ query: { directory: '/repo' } }, listed);
    expect(listed.body).toEqual([{ path: '/repo', branch: 'main' }]);
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledWith('/repo');

    await route({ query: { directory: '/plain-folder' } }, createMockResponse());
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledTimes(1);

    const failed = createMockResponse();
    await route({ query: { directory: '/repo' } }, failed);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toEqual({ error: 'git failed' });
    errorSpy.mockRestore();
  });

  it('forwards topology changes to the control event emitter once', async () => {
    let listener = null;
    gitLibraries.subscribeWorktreeTopologyChanges.mockImplementation((next) => {
      listener = next;
      return () => undefined;
    });
    gitLibraries.getWorktrees.mockResolvedValue([]);
    const emitWorktreeChanged = vi.fn();
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { emitWorktreeChanged });
    const route = getRoute('GET', '/api/git/worktrees');

    await route({ query: { directory: '/repo' } }, createMockResponse());
    await route({ query: { directory: '/repo' } }, createMockResponse());
    expect(gitLibraries.subscribeWorktreeTopologyChanges).toHaveBeenCalledTimes(1);

    listener({ directories: ['/repo'], at: 123 });
    expect(emitWorktreeChanged).toHaveBeenCalledWith({ directories: ['/repo'], at: 123 });
  });
});

describe('git worktree removal instance disposal', () => {
  let fetchMock;

  const createJsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  beforeEach(() => {
    gitLibraries.removeWorktree.mockReset();
    fetchMock = vi.fn(async () => createJsonResponse(true));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes a disposal hook that targets the removed worktree when the runtime helpers are wired', async () => {
    gitLibraries.removeWorktree.mockResolvedValue(true);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      emitWorktreeChanged: vi.fn(),
      buildOpenCodeUrl: (routePath) => `http://opencode.test${routePath}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    });

    const response = createMockResponse();
    await getRoute('DELETE', '/api/git/worktrees')(
      { query: { directory: '/repo' }, body: { directory: '/repo/wt', deleteLocalBranch: true } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(gitLibraries.removeWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
      directory: '/repo/wt',
      deleteLocalBranch: true,
    }));

    const disposeInstance = gitLibraries.removeWorktree.mock.calls[0][1].disposeInstance;
    await disposeInstance('/repo/wt');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://opencode.test/instance/dispose?directory=%2Frepo%2Fwt');
    expect(request.headers.get('authorization')).toBe('Bearer test');
  });

  it('rejects disposal errors so the removal wrapper can warn without failing', async () => {
    gitLibraries.removeWorktree.mockResolvedValue(true);
    fetchMock.mockResolvedValue(createJsonResponse({ name: 'BadRequest', data: { message: 'Bad request' } }, 400));

    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, {
      buildOpenCodeUrl: () => 'http://opencode.test/',
      getOpenCodeAuthHeaders: () => ({}),
    });

    await getRoute('DELETE', '/api/git/worktrees')(
      { query: { directory: '/repo' }, body: { directory: '/repo/wt' } },
      createMockResponse(),
    );

    const disposeInstance = gitLibraries.removeWorktree.mock.calls[0][1].disposeInstance;
    await expect(disposeInstance('/repo/wt')).rejects.toThrow('Bad request');
  });

  it('removes a worktree without a disposal hook when the runtime helpers are absent', async () => {
    gitLibraries.removeWorktree.mockResolvedValue(true);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    const response = createMockResponse();
    await getRoute('DELETE', '/api/git/worktrees')(
      { query: { directory: '/repo' }, body: { directory: '/repo/wt' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(gitLibraries.removeWorktree).toHaveBeenCalledWith('/repo', {
      directory: '/repo/wt',
      deleteLocalBranch: false,
      disposeInstance: undefined,
    });
  });
});

describe('git routes status discovery', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
  });

  it('returns a soft non-repo payload for non-git folders', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(false);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/tmp/not-a-repo' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      isGitRepository: false,
      files: [],
      branch: null,
      ahead: 0,
      behind: 0,
    });
    expect(gitLibraries.getStatus).not.toHaveBeenCalled();
  });

  it('does not abort when getStatus throws a non-repo GitError', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockRejectedValue(
      Object.assign(new Error('fatal: not a git repository (or any of the parent directories): .git'), {
        task: { commands: ['status'] },
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/opened/project' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ isGitRepository: false });
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/project', { mode: undefined });
  });

  it('uses the opened project path from query arrays without falling back to cwd', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockResolvedValue({ current: 'main', files: [], isClean: true, ahead: 0, behind: 0 });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: ['/opened/git-project', '/ignored'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.isGitRepository).toHaveBeenCalledWith('/opened/git-project');
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/git-project', { mode: undefined });
    expect(response.body).toMatchObject({ current: 'main' });
  });
});
