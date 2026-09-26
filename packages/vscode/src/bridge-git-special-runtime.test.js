import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  getGitRangeFiles: mock(),
  getGitRangeDiff: mock(),
};

const sdkClient = {
  model: {
    list: mock(),
  },
  generate: {
    text: mock(),
  },
};

const make = mock(() => sdkClient);
const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

const gitExecutionRuntime = {
  discover: mock(),
  withRawRead: mock(),
};
const rawReadOptions = [];

mock.module('./gitService', () => gitService);
mock.module('@opencode/client', () => ({ OpenCode: { make } }));
mock.module('./git-execution-runtime', () => ({ gitExecutionRuntime }));

const { handleSpecialGitBridgeMessage, setUnavailableRetryDelaysForTest } = await import('./bridge-git-special-runtime');

describe('bridge git special runtime', () => {
  beforeEach(() => {
    gitService.getGitRangeFiles.mockReset();
    gitService.getGitRangeDiff.mockReset();
    sdkClient.model.list.mockReset();
    sdkClient.generate.text.mockReset();
    make.mockReset();
    gitExecutionRuntime.discover.mockReset();
    gitExecutionRuntime.withRawRead.mockReset();
    rawReadOptions.length = 0;
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    make.mockImplementation(() => sdkClient);
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
    sdkClient.model.list.mockImplementation(async () => ({
      location: { directory: '/repo', project: { id: 'p', directory: '/repo', canonical: '/repo' } },
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
    }));
    sdkClient.generate.text.mockImplementation(async () => ({
      text: '{"title":"PR title","body":"PR body"}',
    }));
  });

  it('generates PR descriptions through the OpenCode generate route', async () => {
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
    expect(make).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test' },
    });
    expect(sdkClient.model.list).toHaveBeenCalled();
    expect(sdkClient.generate.text).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports the failure instead of a half-written description when generation fails', async () => {
    sdkClient.generate.text.mockImplementation(async () => {
      throw new Error('model unavailable');
    });

    const response = await handleSpecialGitBridgeMessage({
      id: '2',
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

    expect(response).toEqual({ id: '2', type: 'api:git/pr-description', success: false, error: 'model unavailable' });
  });

  describe('while the model is still loading', () => {
    const unavailable = { _tag: 'InvalidRequestError', message: 'Model unavailable: anthropic/claude-sonnet-4-5' };
    const request = () => handleSpecialGitBridgeMessage({
      id: '3',
      type: 'api:git/pr-description',
      payload: { directory: '/repo', base: 'main', head: 'feature', providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
    }, {
      manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) },
    }, { readSettings: () => ({}), execGit: mock() });

    beforeEach(() => setUnavailableRetryDelaysForTest([1, 1]));

    it('retries with backoff until the model appears', async () => {
      let calls = 0;
      sdkClient.generate.text.mockImplementation(async () => {
        calls += 1;
        if (calls <= 2) throw unavailable;
        return { text: '{"title":"PR title","body":"PR body"}' };
      });

      const response = await request();

      expect(response.success).toBe(true);
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(3);
      setUnavailableRetryDelaysForTest();
    });

    it('gives up once the backoff runs out and never retries other errors', async () => {
      sdkClient.generate.text.mockImplementation(async () => { throw unavailable; });
      expect((await request()).success).toBe(false);
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(3);

      sdkClient.generate.text.mockReset();
      sdkClient.generate.text.mockImplementation(async () => { throw { _tag: 'InvalidRequestError', message: 'Invalid prompt' }; });
      await request();
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(1);
      setUnavailableRetryDelaysForTest();
    });
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
    expect(sdkClient.generate.text).not.toHaveBeenCalled();
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
    expect(sdkClient.generate.text).not.toHaveBeenCalled();
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

  it('does not interpret cleanup-blocked conflict output as an empty successful result', async () => {
    const cleanupBlocked = {
      stdout: '',
      stderr: 'Git process cleanup was not confirmed',
      exitCode: 1,
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
    };

    const response = await handleSpecialGitBridgeMessage({
      id: 'conflict-cleanup-blocked',
      type: 'api:git/conflict-details',
      payload: { directory: '/repo' },
    }, undefined, {
      readSettings: () => ({}),
      execGit: async () => cleanupBlocked,
    });

    expect(response).toEqual({
      id: 'conflict-cleanup-blocked',
      type: 'api:git/conflict-details',
      success: false,
      error: 'Git process cleanup was not confirmed',
    });
    expect(rawReadOptions).toHaveLength(1);
  });
});
