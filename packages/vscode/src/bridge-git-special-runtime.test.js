import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  getGitRangeFiles: mock(),
  getGitRangeDiff: mock(),
};

const sdkClient = {
  v2: {
    model: {
      list: mock(),
    },
  },
  session: {
    create: mock(),
    promptAsync: mock(),
    messages: mock(),
    delete: mock(),
  },
};

const createOpencodeClient = mock(() => sdkClient);
const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

const gitExecutionRuntime = {
  discover: mock(),
  withRawRead: mock(),
};
const rawReadOptions = [];

mock.module('./gitService', () => gitService);
mock.module('@opencode-ai/sdk/v2', () => ({ createOpencodeClient }));
mock.module('./git-execution-runtime', () => ({ gitExecutionRuntime }));

const { handleSpecialGitBridgeMessage } = await import('./bridge-git-special-runtime');

describe('bridge git special runtime', () => {
  beforeEach(() => {
    gitService.getGitRangeFiles.mockReset();
    gitService.getGitRangeDiff.mockReset();
    sdkClient.v2.model.list.mockReset();
    sdkClient.session.create.mockReset();
    sdkClient.session.promptAsync.mockReset();
    sdkClient.session.messages.mockReset();
    sdkClient.session.delete.mockReset();
    createOpencodeClient.mockReset();
    gitExecutionRuntime.discover.mockReset();
    gitExecutionRuntime.withRawRead.mockReset();
    rawReadOptions.length = 0;
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    createOpencodeClient.mockImplementation(() => sdkClient);
    gitExecutionRuntime.discover.mockResolvedValue({
      isRepository: true,
      requestedDirectory: '/repo',
      topLevel: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      commonId: '/repo/.git',
      worktreeId: '/repo',
    });
    gitExecutionRuntime.withRawRead.mockImplementation((_directory, task, options) => {
      rawReadOptions.push(options);
      return task();
    });
    gitService.getGitRangeFiles.mockImplementation(async () => ['src/a.ts']);
    gitService.getGitRangeDiff.mockImplementation(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line' }));
    sdkClient.v2.model.list.mockImplementation(async () => ({
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
      error: undefined,
    }));
    sdkClient.session.create.mockImplementation(async () => ({
      data: { id: 'ses_1' },
      error: undefined,
    }));
    sdkClient.session.promptAsync.mockImplementation(async () => ({ data: true, error: undefined }));
    sdkClient.session.messages.mockImplementation(async () => ({
      data: [{
        info: { role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: '{"title":"PR title","body":"PR body"}' }],
      }],
      error: undefined,
    }));
    sdkClient.session.delete.mockImplementation(async () => ({ data: true, error: undefined }));
  });

  it('generates PR descriptions through the OpenCode SDK session flow', async () => {
    const response = await handleSpecialGitBridgeMessage({
      id: '1',
      type: 'api:git/pr-description',
      payload: {
        directory: '/repo',
        base: 'main',
        head: 'feature',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '1',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'PR title', body: 'PR body' },
    });
    expect(rawFetch).not.toHaveBeenCalled();
    expect(rawReadOptions).toHaveLength(2);
    expect(rawReadOptions.every((options) => options?.signal instanceof AbortSignal
      && options.queueTimeoutMs === 3_000)).toBe(true);
    expect(gitService.getGitRangeFiles).toHaveBeenCalledWith(
      '/repo',
      'main',
      'feature',
      { signal: rawReadOptions[0].signal },
    );
    expect(gitService.getGitRangeDiff).toHaveBeenCalledWith(
      '/repo',
      'main',
      'feature',
      'src/a.ts',
      3,
      { signal: rawReadOptions[1].signal },
    );
    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test' },
    });
    expect(sdkClient.v2.model.list).toHaveBeenCalled();
    expect(sdkClient.session.create).toHaveBeenCalledWith({
      directory: '/repo',
      title: 'Git Generation',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_1',
      directory: '/repo',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.messages).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      directory: '/repo',
      limit: 10,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.delete).toHaveBeenCalledWith({ sessionID: 'ses_1' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('does not turn discovery failures into an empty diff response', async () => {
    gitExecutionRuntime.discover.mockRejectedValue(
      Object.assign(new Error('Git context discovery failed: permission denied'), { code: 'EACCES' }),
    );

    await expect(handleSpecialGitBridgeMessage({
      id: 'discovery-failure',
      type: 'api:git/pr-description',
      payload: { directory: '/repo', base: 'main', head: 'feature' },
    }, undefined, {
      readSettings: () => ({}),
      execGit: mock(),
    })).rejects.toThrow('permission denied');

    expect(gitService.getGitRangeFiles).not.toHaveBeenCalled();
    expect(sdkClient.session.create).not.toHaveBeenCalled();
  });

  it('keeps the empty diff response for a confirmed non-repository', async () => {
    gitExecutionRuntime.discover.mockResolvedValue({
      isRepository: false,
      requestedDirectory: '/repo',
      reason: 'not-a-repository',
    });

    await expect(handleSpecialGitBridgeMessage({
      id: 'non-repository',
      type: 'api:git/pr-description',
      payload: { directory: '/repo', base: 'main', head: 'feature' },
    }, undefined, {
      readSettings: () => ({}),
      execGit: mock(),
    })).resolves.toEqual({
      id: 'non-repository',
      type: 'api:git/pr-description',
      success: false,
      error: 'No diffs available for base...head',
    });
    expect(gitService.getGitRangeFiles).not.toHaveBeenCalled();
  });

  it('does not turn range execution failures into an empty diff response', async () => {
    gitService.getGitRangeFiles.mockRejectedValue(new Error('Git range file discovery failed: bad revision'));

    await expect(handleSpecialGitBridgeMessage({
      id: 'range-failure',
      type: 'api:git/pr-description',
      payload: { directory: '/repo', base: 'main', head: 'feature' },
    }, undefined, {
      readSettings: () => ({}),
      execGit: mock(),
    })).rejects.toThrow('bad revision');
    expect(sdkClient.session.create).not.toHaveBeenCalled();
  });

  it('passes the bounded status signal to every raw conflict-details command', async () => {
    const execOptions = [];
    const response = await handleSpecialGitBridgeMessage({
      id: 'conflict-details',
      type: 'api:git/conflict-details',
      payload: { directory: '/repo' },
    }, undefined, {
      readSettings: () => ({}),
      execGit: async (args, _directory, options) => {
        execOptions.push({ args, options });
        if (args[0] === 'status') {
          return { stdout: ' M src/a.ts\n', stderr: '', exitCode: 0 };
        }
        if (args[1] === '--name-only') {
          return { stdout: 'src/a.ts\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'diff') {
          return { stdout: 'diff --git a/src/a.ts b/src/a.ts\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    expect(response).toMatchObject({
      id: 'conflict-details',
      type: 'api:git/conflict-details',
      success: true,
    });
    expect(execOptions).toHaveLength(5);
    expect(execOptions.every(({ options }) => options?.signal instanceof AbortSignal)).toBe(true);
    expect(rawReadOptions).toHaveLength(5);
    expect(rawReadOptions.every((options) => options?.signal instanceof AbortSignal
      && options.queueTimeoutMs === 3_000)).toBe(true);
  });
});
