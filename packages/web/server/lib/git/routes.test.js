import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitLibraries = {
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  getGitHistoryRefs: vi.fn(),
  getGitHistory: vi.fn(),
  getGitHistoryMergeBase: vi.fn(),
  getCommitFiles: vi.fn(),
  getCommitFileDiff: vi.fn(),
};

vi.mock('./index.js', () => ({
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  isGitRepository: gitLibraries.isGitRepository,
  getStatus: gitLibraries.getStatus,
  getGitHistoryRefs: gitLibraries.getGitHistoryRefs,
  getGitHistory: gitLibraries.getGitHistory,
  getGitHistoryMergeBase: gitLibraries.getGitHistoryMergeBase,
  getCommitFiles: gitLibraries.getCommitFiles,
  getCommitFileDiff: gitLibraries.getCommitFileDiff,
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
    setHeader() {},
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
    gitLibraries.getGitHistoryRefs.mockReset();
    gitLibraries.getGitHistory.mockReset();
    gitLibraries.getGitHistoryMergeBase.mockReset();
    gitLibraries.getCommitFiles.mockReset();
    gitLibraries.getCommitFileDiff.mockReset();
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

describe('git history routes', () => {
  beforeEach(() => {
    gitLibraries.getGitHistoryRefs.mockReset();
    gitLibraries.getGitHistory.mockReset();
    gitLibraries.getGitHistoryMergeBase.mockReset();
  });

  it('requires a directory for refs discovery', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/history/refs')({ query: {} }, response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'directory parameter is required' });
  });

  it('rejects invalid history ref payloads before invoking git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    const emptyResponse = createMockResponse();
    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', refs: [] } },
      emptyResponse,
    );
    expect(emptyResponse.statusCode).toBe(400);
    expect(gitLibraries.getGitHistory).not.toHaveBeenCalled();

    const optionResponse = createMockResponse();
    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', refs: ['--all'] } },
      optionResponse,
    );
    expect(optionResponse.statusCode).toBe(400);
    expect(optionResponse.body).toEqual({ error: 'refs must not contain option-like values' });

    const cursorResponse = createMockResponse();
    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', refs: ['HEAD'], cursor: '%%%bad%%%' } },
      cursorResponse,
    );
    expect(cursorResponse.statusCode).toBe(400);
    expect(cursorResponse.body).toEqual({ error: 'cursor is malformed' });

    const limitResponse = createMockResponse();
    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', refs: ['HEAD'], limit: '500' } },
      limitResponse,
    );
    expect(limitResponse.statusCode).toBe(400);
    expect(limitResponse.body).toEqual({ error: 'limit must be between 1 and 100' });
  });

  it('returns bounded 4xx responses for service validation failures', async () => {
    gitLibraries.getGitHistory.mockRejectedValue(Object.assign(new Error('Unknown ref: refs/heads/missing'), {
      statusCode: 400,
    }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', refs: ['refs/heads/missing'] } },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'Unknown ref: refs/heads/missing' });
  });

  it('passes repeated refs through without comma ambiguity', async () => {
    gitLibraries.getGitHistory.mockResolvedValue({ items: [], nextCursor: null, hasMore: false, refsSnapshot: 'snap' });
    gitLibraries.getGitHistoryMergeBase.mockResolvedValue({ mergeBase: null });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    const historyResponse = createMockResponse();
    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', refs: ['HEAD', 'refs/heads/main'], limit: '25' } },
      historyResponse,
    );
    expect(historyResponse.statusCode).toBe(200);
    expect(gitLibraries.getGitHistory).toHaveBeenCalledWith('/repo', {
      refs: ['HEAD', 'refs/heads/main'],
      cursor: undefined,
      limit: 25,
    });

    const mergeBaseResponse = createMockResponse();
    await getRoute('GET', '/api/git/history/merge-base')(
      { query: { directory: '/repo', refs: ['HEAD', 'refs/heads/main'] } },
      mergeBaseResponse,
    );
    expect(mergeBaseResponse.statusCode).toBe(200);
    expect(gitLibraries.getGitHistoryMergeBase).toHaveBeenCalledWith('/repo', {
      refs: ['HEAD', 'refs/heads/main'],
    });
  });

  it('accepts canonical all and rejects ambiguous all-plus-refs requests', async () => {
    gitLibraries.getGitHistory.mockResolvedValue({ items: [], nextCursor: null, hasMore: false, refsSnapshot: 'snap' });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    const allResponse = createMockResponse();
    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', all: 'true' } },
      allResponse,
    );
    expect(allResponse.statusCode).toBe(200);
    expect(gitLibraries.getGitHistory).toHaveBeenCalledWith('/repo', {
      all: true,
      cursor: undefined,
      limit: undefined,
    });

    const ambiguousResponse = createMockResponse();
    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', all: 'true', refs: ['HEAD'] } },
      ambiguousResponse,
    );
    expect(ambiguousResponse.statusCode).toBe(400);
    expect(ambiguousResponse.body).toEqual({ error: 'all cannot be combined with explicit refs' });

    const optionResponse = createMockResponse();
    await getRoute('GET', '/api/git/history')(
      { query: { directory: '/repo', all: 'false', refs: ['--all'] } },
      optionResponse,
    );
    expect(optionResponse.statusCode).toBe(400);
    expect(optionResponse.body).toEqual({ error: 'refs must not contain option-like values' });
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

describe('git commit file routes', () => {
  beforeEach(() => {
    gitLibraries.getCommitFiles.mockReset();
    gitLibraries.getCommitFileDiff.mockReset();
  });

  it('passes object-style commit file metadata requests through the route boundary', async () => {
    gitLibraries.getCommitFiles.mockResolvedValue({ files: [] });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/commit-files')(
      {
        query: {
          directory: '/repo',
          commitHash: 'a'.repeat(40),
          parentHash: 'b'.repeat(40),
        },
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.getCommitFiles).toHaveBeenCalledWith('/repo', {
      commitHash: 'a'.repeat(40),
      parentHash: 'b'.repeat(40),
    });
  });

  it('uses the root marker for null parent and nullable preview paths', async () => {
    gitLibraries.getCommitFileDiff.mockResolvedValue({ status: 'ready', original: '', modified: 'root\n' });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/commit-file-diff')(
      {
        query: {
          directory: '/repo',
          commitHash: 'c'.repeat(40),
          parentHash: '__ROOT__',
          originalPath: '__ROOT__',
          modifiedPath: 'root.txt',
        },
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.getCommitFileDiff).toHaveBeenCalledWith('/repo', {
      commitHash: 'c'.repeat(40),
      parentHash: null,
      originalPath: null,
      modifiedPath: 'root.txt',
    });
  });

  it('rejects abbreviated or malformed commit hash payloads before invoking git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const metadataResponse = createMockResponse();

    await getRoute('GET', '/api/git/commit-files')(
      {
        query: {
          directory: '/repo',
          commitHash: 'abc1234',
          parentHash: '__ROOT__',
        },
      },
      metadataResponse,
    );

    expect(metadataResponse.statusCode).toBe(400);
    expect(gitLibraries.getCommitFiles).not.toHaveBeenCalled();

    const previewResponse = createMockResponse();
    await getRoute('GET', '/api/git/commit-file-diff')(
      {
        query: {
          directory: '/repo',
          commitHash: 'd'.repeat(40),
          parentHash: 'bad-parent',
          originalPath: 'a.ts',
          modifiedPath: 'b.ts',
        },
      },
      previewResponse,
    );

    expect(previewResponse.statusCode).toBe(400);
    expect(gitLibraries.getCommitFileDiff).not.toHaveBeenCalled();
  });
});
