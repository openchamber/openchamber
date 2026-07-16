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

mock.module('@opencode-ai/sdk/v2', () => ({ createOpencodeClient }));

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
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    createOpencodeClient.mockImplementation(() => sdkClient);
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
      getGitRangeFiles: gitService.getGitRangeFiles,
      getGitRangeDiff: gitService.getGitRangeDiff,
      withGitRawRead: async (_directory, task) => task(mock()),
    });

    expect(response).toEqual({
      id: '1',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'PR title', body: 'PR body' },
    });
    expect(rawFetch).not.toHaveBeenCalled();
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

  it('holds one scheduled raw-read boundary across conflict-detail probes', async () => {
    const calls = [];
    const execGit = mock(async (args) => {
      calls.push(args);
      if (args[0] === 'status') return { stdout: 'UU src/a.ts\n', stderr: '', exitCode: 0 };
      if (args.includes('--name-only')) return { stdout: 'src/a.ts\n', stderr: '', exitCode: 0 };
      if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.ts b/src/a.ts', stderr: '', exitCode: 0 };
      return { stdout: 'abcdef123456\n', stderr: '', exitCode: 0 };
    });
    const withGitRawRead = mock(async (_directory, task) => task(execGit));

    const response = await handleSpecialGitBridgeMessage({
      id: '2',
      type: 'api:git/conflict-details',
      payload: { directory: '/repo' },
    }, undefined, {
      readSettings: () => ({}),
      getGitRangeFiles: gitService.getGitRangeFiles,
      getGitRangeDiff: gitService.getGitRangeDiff,
      withGitRawRead,
    });

    expect(response).toMatchObject({
      id: '2',
      type: 'api:git/conflict-details',
      success: true,
      data: {
        statusPorcelain: 'UU src/a.ts',
        unmergedFiles: ['src/a.ts'],
        operation: 'merge',
      },
    });
    expect(withGitRawRead).toHaveBeenCalledTimes(1);
    expect(withGitRawRead).toHaveBeenCalledWith('/repo', expect.any(Function));
    expect(calls).toEqual([
      ['status', '--porcelain'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['diff'],
      ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
    ]);
  });
});
