import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitLibraries = {
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  getRangeDiff: vi.fn(),
  getRangeFiles: vi.fn(),
  getCommitDiff: vi.fn(),
  getCommitFiles: vi.fn(),
  getCommitFileDiff: vi.fn(),
  getConflictDetails: vi.fn(),
  getWorktrees: vi.fn(),
  getBranches: vi.fn(),
  getRemotes: vi.fn(),
  listStashes: vi.fn(),
  countStashFiles: vi.fn(),
  getLog: vi.fn(),
  getBranchBase: vi.fn(),
  getUnpushedBranchCounts: vi.fn(),
  observeWorktreeTopology: vi.fn(),
  subscribeWorktreeTopologyChanges: vi.fn(),
  resolvePrimaryWorktreeRoot: vi.fn(),
  resolveWorktreeTopLevel: vi.fn(),
  getPathDiff: vi.fn(),
  getFileDiff: vi.fn(),
  validateWorktreeCreate: vi.fn(),
  previewWorktreeCreate: vi.fn(),
};

vi.mock('./index.js', () => ({
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  isGitRepository: gitLibraries.isGitRepository,
  getStatus: gitLibraries.getStatus,
  getRangeDiff: gitLibraries.getRangeDiff,
  getRangeFiles: gitLibraries.getRangeFiles,
  getCommitDiff: gitLibraries.getCommitDiff,
  getCommitFiles: gitLibraries.getCommitFiles,
  getCommitFileDiff: gitLibraries.getCommitFileDiff,
  getConflictDetails: gitLibraries.getConflictDetails,
  getWorktrees: gitLibraries.getWorktrees,
  getBranches: gitLibraries.getBranches,
  getRemotes: gitLibraries.getRemotes,
  listStashes: gitLibraries.listStashes,
  countStashFiles: gitLibraries.countStashFiles,
  getLog: gitLibraries.getLog,
  getBranchBase: gitLibraries.getBranchBase,
  getUnpushedBranchCounts: gitLibraries.getUnpushedBranchCounts,
  observeWorktreeTopology: gitLibraries.observeWorktreeTopology,
  subscribeWorktreeTopologyChanges: gitLibraries.subscribeWorktreeTopologyChanges,
  resolvePrimaryWorktreeRoot: gitLibraries.resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel: gitLibraries.resolveWorktreeTopLevel,
  getPathDiff: gitLibraries.getPathDiff,
  getFileDiff: gitLibraries.getFileDiff,
  validateWorktreeCreate: gitLibraries.validateWorktreeCreate,
  previewWorktreeCreate: gitLibraries.previewWorktreeCreate,
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

const waitForMockCall = async (mock) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for mock call');
};

describe('git routes index mutations', () => {
  beforeEach(() => {
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.getRangeDiff.mockReset();
    gitLibraries.getRangeFiles.mockReset();
    gitLibraries.getCommitDiff.mockReset();
    gitLibraries.getCommitFiles.mockReset();
    gitLibraries.getCommitFileDiff.mockReset();
    gitLibraries.getConflictDetails.mockReset();
    gitLibraries.resolvePrimaryWorktreeRoot.mockReset();
    gitLibraries.resolveWorktreeTopLevel.mockReset();
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

describe('git diff routes', () => {
  beforeEach(() => {
    gitLibraries.getPathDiff.mockReset();
    gitLibraries.getFileDiff.mockReset();
  });

  it('admits path diffs through the execution facade with request cancellation', async () => {
    gitLibraries.getPathDiff.mockResolvedValue({ diff: 'patch', submodule: null });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/diff')(
      { query: { directory: '/repo', path: 'file.ts' } },
      response,
    );

    expect(response.body).toEqual({ diff: 'patch', submodule: null });
    expect(gitLibraries.getPathDiff).toHaveBeenCalledWith('/repo', expect.objectContaining({
      path: 'file.ts',
      signal: expect.any(AbortSignal),
    }));
  });

  it('passes request cancellation into file diffs without changing the response shape', async () => {
    gitLibraries.getFileDiff.mockResolvedValue({
      original: 'old',
      modified: 'new',
      path: 'file.ts',
      isBinary: false,
      submodule: null,
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/file-diff')(
      { query: { directory: '/repo', path: 'file.ts' } },
      response,
    );

    expect(response.body).toEqual({
      original: 'old',
      modified: 'new',
      path: 'file.ts',
      isBinary: false,
      submodule: null,
    });
    expect(gitLibraries.getFileDiff).toHaveBeenCalledWith('/repo', expect.objectContaining({
      path: 'file.ts',
      signal: expect.any(AbortSignal),
    }));
  });
});

describe('git cancellation routes', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getConflictDetails.mockReset();
  });

  it('passes request cancellation into repository checks', async () => {
    let options;
    gitLibraries.isGitRepository.mockImplementation((_directory, nextOptions) => {
      options = nextOptions;
      return new Promise((_resolve, reject) => {
        nextOptions.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
      });
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const request = Object.assign(new EventEmitter(), { query: { directory: '/repo' } });
    const response = createMockResponse();

    const pending = getRoute('GET', '/api/git/check')(request, response);
    for (let attempt = 0; attempt < 20 && !options; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    request.emit('aborted');
    await pending;

    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(true);
    expect(response.body).toBeNull();
  });

  it('passes request cancellation into conflict details without changing its response', async () => {
    const result = {
      statusPorcelain: '',
      unmergedFiles: [],
      diff: '',
      headInfo: '',
      operation: 'merge',
    };
    gitLibraries.getConflictDetails.mockResolvedValue(result);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/conflict-details')(
      { query: { directory: '/repo' } },
      response,
    );

    expect(gitLibraries.getConflictDetails).toHaveBeenCalledWith('/repo', {
      signal: expect.any(AbortSignal),
    });
    expect(response.body).toEqual(result);
  });
});

describe('git collection routes', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.getRangeDiff.mockReset();
    gitLibraries.getRangeFiles.mockReset();
    gitLibraries.getCommitDiff.mockReset();
    gitLibraries.getCommitFiles.mockReset();
    gitLibraries.getCommitFileDiff.mockReset();
    gitLibraries.observeWorktreeTopology.mockReset();
    gitLibraries.observeWorktreeTopology.mockResolvedValue(undefined);
  });

  it.each([
    ['status', '/api/git/status', { directory: '/repo' }, 'getStatus'],
    ['range', '/api/git/range-diff', { directory: '/repo', base: 'main', head: 'feature' }, 'getRangeDiff'],
    ['commit', '/api/git/commit-diff', { directory: '/repo', hash: 'a'.repeat(40) }, 'getCommitDiff'],
  ])('passes a request signal through the %s route', async (_label, routePath, query, operation) => {
    if (operation === 'getStatus') {
      gitLibraries.isGitRepository.mockResolvedValue(true);
      gitLibraries.getStatus.mockResolvedValue({ current: 'main' });
    } else if (operation === 'getRangeDiff') {
      gitLibraries.getRangeDiff.mockResolvedValue('patch');
    } else {
      gitLibraries.getCommitDiff.mockResolvedValue('patch');
    }

    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    await getRoute('GET', routePath)({ query }, createMockResponse());

    expect(gitLibraries[operation]).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('passes request cancellation through committed-file routes', async () => {
    gitLibraries.getCommitFiles.mockResolvedValue({ files: [] });
    gitLibraries.getCommitFileDiff.mockResolvedValue({ original: '', modified: '', isBinary: false });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    await getRoute('GET', '/api/git/commit-files')(
      { query: { directory: '/repo', hash: 'a'.repeat(40) } },
      createMockResponse(),
    );
    await getRoute('GET', '/api/git/commit-file-diff')(
      { query: { directory: '/repo', hash: 'a'.repeat(40), path: 'file.ts' } },
      createMockResponse(),
    );

    expect(gitLibraries.getCommitFiles).toHaveBeenCalledWith('/repo', 'a'.repeat(40), {
      signal: expect.any(AbortSignal),
    });
    expect(gitLibraries.getCommitFileDiff).toHaveBeenCalledWith(
      '/repo',
      'a'.repeat(40),
      'file.ts',
      false,
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ['commit files', '/api/git/commit-files', { directory: '/repo', hash: 'a'.repeat(40) }, 'getCommitFiles', { files: [] }],
    ['commit diff', '/api/git/commit-diff', { directory: '/repo', hash: 'a'.repeat(40) }, 'getCommitDiff', 'patch'],
    ['commit file diff', '/api/git/commit-file-diff', { directory: '/repo', hash: 'a'.repeat(40), path: 'file.ts' }, 'getCommitFileDiff', { original: '', modified: '', isBinary: false }],
  ])('does not respond with a committed %s result after disconnect', async (_label, routePath, query, operation, result) => {
    let release;
    gitLibraries[operation].mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const request = Object.assign(new EventEmitter(), { query });
    const response = createMockResponse();
    const pending = getRoute('GET', routePath)(request, response);
    await waitForMockCall(gitLibraries[operation]);

    request.emit('aborted');
    release(result);
    await pending;

    expect(response.body).toBeNull();
  });

  it.each([
    ['commit files', '/api/git/commit-files', { directory: '/repo', hash: 'a'.repeat(40) }, 'getCommitFiles'],
    ['commit diff', '/api/git/commit-diff', { directory: '/repo', hash: 'a'.repeat(40) }, 'getCommitDiff'],
    ['commit file diff', '/api/git/commit-file-diff', { directory: '/repo', hash: 'a'.repeat(40), path: 'file.ts' }, 'getCommitFileDiff'],
  ])('does not log or respond with a committed %s error after disconnect', async (_label, routePath, query, operation) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectOperation;
    gitLibraries[operation].mockImplementation(() => new Promise((_resolve, reject) => {
      rejectOperation = reject;
    }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const request = Object.assign(new EventEmitter(), { query });
    const response = createMockResponse();
    const pending = getRoute('GET', routePath)(request, response);
    await waitForMockCall(gitLibraries[operation]);

    request.emit('aborted');
    rejectOperation(new Error('committed read failed'));
    await pending;

    expect(response.body).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('passes cancellation through range file collection too', async () => {
    gitLibraries.getRangeFiles.mockResolvedValue([]);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    await getRoute('GET', '/api/git/range-files')(
      { query: { directory: '/repo', base: 'main', head: 'feature' } },
      createMockResponse(),
    );

    expect(gitLibraries.getRangeFiles).toHaveBeenCalledWith('/repo', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ['status', '/api/git/status', { directory: '/repo' }, 'getStatus'],
    ['diff', '/api/git/diff', { directory: '/repo', path: 'file.ts' }, 'getPathDiff'],
    ['range diff', '/api/git/range-diff', { directory: '/repo', base: 'main', head: 'feature' }, 'getRangeDiff'],
    ['range files', '/api/git/range-files', { directory: '/repo', base: 'main', head: 'feature' }, 'getRangeFiles'],
  ])('does not log or answer an ordinary error after the %s request aborts', async (_label, routePath, query, operation) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (operation === 'getStatus') {
      gitLibraries.isGitRepository.mockResolvedValue(true);
    }
    gitLibraries[operation].mockImplementation((_directory, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));

    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const request = Object.assign(new EventEmitter(), { query });
    const response = createMockResponse();
    const pending = getRoute('GET', routePath)(request, response);
    await vi.waitFor(() => expect(gitLibraries[operation]).toHaveBeenCalled());
    request.emit('aborted');
    await pending;

    expect(response.statusCode).toBe(200);
    expect(response.body).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('remaining git read route cancellation', () => {
  beforeEach(() => {
    gitLibraries.getBranches.mockReset().mockResolvedValue({ all: [], current: null, branches: {} });
    gitLibraries.getRemotes.mockReset().mockResolvedValue([]);
    gitLibraries.listStashes.mockReset().mockResolvedValue([]);
    gitLibraries.countStashFiles.mockReset().mockResolvedValue({});
    gitLibraries.getLog.mockReset().mockResolvedValue({ all: [], latest: null, total: 0 });
    gitLibraries.getBranchBase.mockReset().mockResolvedValue({ base: null });
    gitLibraries.getUnpushedBranchCounts.mockReset().mockResolvedValue({ counts: {} });
    gitLibraries.getWorktrees.mockReset().mockResolvedValue([]);
    gitLibraries.resolvePrimaryWorktreeRoot.mockReset().mockResolvedValue({ root: '/repo' });
    gitLibraries.resolveWorktreeTopLevel.mockReset().mockResolvedValue({ root: '/repo' });
  });

  it.each([
    ['branches', 'GET', '/api/git/branches', { directory: '/repo' }, 'getBranches'],
    ['remotes', 'GET', '/api/git/remotes', { directory: '/repo' }, 'getRemotes'],
    ['stashes', 'GET', '/api/git/stashes', { directory: '/repo' }, 'listStashes'],
    ['worktrees', 'GET', '/api/git/worktrees', { directory: '/repo' }, 'getWorktrees'],
    ['log', 'GET', '/api/git/log', { directory: '/repo' }, 'getLog'],
    ['branch base', 'GET', '/api/git/branch-base', { directory: '/repo', branch: 'feature' }, 'getBranchBase'],
    ['primary root', 'GET', '/api/git/primary-root', { directory: '/repo' }, 'resolvePrimaryWorktreeRoot'],
    ['toplevel', 'GET', '/api/git/toplevel', { directory: '/repo' }, 'resolveWorktreeTopLevel'],
  ])('passes a request signal through the %s route', async (_label, method, routePath, query, operation) => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    await getRoute(method, routePath)({ query }, createMockResponse());
    if (operation === 'getBranchBase') {
      expect(gitLibraries[operation]).toHaveBeenCalledWith(
        '/repo',
        'feature',
        { signal: expect.any(AbortSignal) },
      );
    } else {
      expect(gitLibraries[operation]).toHaveBeenCalledWith('/repo', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }
  });

  it('passes request cancellation to network-bound branch push status reads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    await getRoute('POST', '/api/git/branch-push-status')(
      { query: { directory: '/repo' }, body: { branches: ['main'] } },
      createMockResponse(),
    );
    expect(gitLibraries.getUnpushedBranchCounts).toHaveBeenCalledWith(
      '/repo',
      ['main'],
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe('git worktree preflight route cancellation', () => {
  beforeEach(() => {
    gitLibraries.validateWorktreeCreate.mockReset();
    gitLibraries.previewWorktreeCreate.mockReset();
  });

  it.each([
    ['validate', '/api/git/worktrees/validate', 'validateWorktreeCreate'],
    ['preview', '/api/git/worktrees/preview', 'previewWorktreeCreate'],
  ])('cancels %s without a late response or error log after disconnect', async (_label, routePath, operation) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gitLibraries[operation].mockImplementation((_directory, _input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const request = Object.assign(new EventEmitter(), { query: { directory: '/repo' }, body: {} });
    const response = createMockResponse();

    const pending = getRoute('POST', routePath)(request, response);
    await waitForMockCall(gitLibraries[operation]);
    request.emit('aborted');
    await pending;

    expect(gitLibraries[operation]).toHaveBeenCalledWith('/repo', {}, { signal: expect.any(AbortSignal) });
    expect(response.body).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it.each([
    ['validate', '/api/git/worktrees/validate', 'validateWorktreeCreate'],
    ['preview', '/api/git/worktrees/preview', 'previewWorktreeCreate'],
  ])('preserves the %s error response while the client remains connected', async (_label, routePath, operation) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gitLibraries[operation].mockRejectedValue(new Error('preflight failed'));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', routePath)({ query: { directory: '/repo' }, body: {} }, response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'preflight failed' });
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
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

describe('git routes status discovery', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.resolvePrimaryWorktreeRoot.mockReset();
    gitLibraries.resolveWorktreeTopLevel.mockReset();
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
        code: 'GIT_NOT_A_REPOSITORY',
        reason: 'not-a-repository',
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
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/project', {
      mode: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it('does not soften a permission error that mentions a non-repository', async () => {
    gitLibraries.isGitRepository.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied while checking (not a git repository)'), {
        code: 'EACCES',
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/check')(
      { query: { directory: '/protected-repo' } },
      response,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to check git repository' });
  });

  it('does not soften a missing Git executable as a deleted directory', async () => {
    gitLibraries.isGitRepository.mockRejectedValue(
      Object.assign(new Error('Git context discovery failed'), {
        code: 'ENOENT',
        details: { operation: 'git-context-discovery' },
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/check')(
      { query: { directory: '/repo' } },
      response,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to check git repository' });
  });

  it('keeps deleted-directory soft behavior for check, status, and root routes', async () => {
    const directory = '/deleted-worktree';
    gitLibraries.isGitRepository.mockResolvedValue(false);
    gitLibraries.resolvePrimaryWorktreeRoot.mockResolvedValue({ root: directory });
    gitLibraries.resolveWorktreeTopLevel.mockResolvedValue({ root: directory });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    const checkResponse = createMockResponse();
    await getRoute('GET', '/api/git/check')({ query: { directory } }, checkResponse);
    expect(checkResponse.statusCode).toBe(200);
    expect(checkResponse.body).toEqual({ isGitRepository: false });

    const statusResponse = createMockResponse();
    await getRoute('GET', '/api/git/status')({ query: { directory } }, statusResponse);
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.body).toEqual({
      isGitRepository: false,
      files: [],
      branch: null,
      ahead: 0,
      behind: 0,
    });

    const primaryResponse = createMockResponse();
    await getRoute('GET', '/api/git/primary-root')({ query: { directory } }, primaryResponse);
    expect(primaryResponse.statusCode).toBe(200);
    expect(primaryResponse.body).toEqual({ root: directory });

    const topLevelResponse = createMockResponse();
    await getRoute('GET', '/api/git/toplevel')({ query: { directory } }, topLevelResponse);
    expect(topLevelResponse.statusCode).toBe(200);
    expect(topLevelResponse.body).toEqual({ root: directory });
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
    expect(gitLibraries.isGitRepository).toHaveBeenCalledWith('/opened/git-project', {
      signal: expect.any(AbortSignal),
    });
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/git-project', {
      mode: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(response.body).toMatchObject({ current: 'main' });
  });
});
