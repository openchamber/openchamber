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
const v2Client = {
  model: { list: mock() },
  session: {
    create: mock(),
    prompt: mock(),
    wait: mock(),
    remove: mock(),
  },
  message: { list: mock() },
};
const makeV2Client = mock(() => v2Client);
const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

mock.module('./gitService', () => gitService);
mock.module('@opencode-ai/sdk/v2', () => ({ createOpencodeClient }));
mock.module('@opencode-ai/client', () => ({ OpenCode: { make: makeV2Client } }));

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
    makeV2Client.mockReset();
    v2Client.model.list.mockReset();
    v2Client.session.create.mockReset();
    v2Client.session.prompt.mockReset();
    v2Client.session.wait.mockReset();
    v2Client.session.remove.mockReset();
    v2Client.message.list.mockReset();
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    createOpencodeClient.mockImplementation(() => sdkClient);
    makeV2Client.mockImplementation(() => v2Client);
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
    v2Client.model.list.mockImplementation(async () => ({
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
    }));
    v2Client.session.create.mockImplementation(async () => ({ id: 'ses_v2' }));
    v2Client.session.prompt.mockImplementation(async () => undefined);
    v2Client.session.wait.mockImplementation(async () => undefined);
    v2Client.message.list.mockImplementation(async () => ({
      data: [{
        id: 'msg_v2',
        type: 'assistant',
        finish: 'stop',
        content: [{ type: 'text', text: '{"title":"V2 PR","body":"V2 body"}' }],
      }],
    }));
    v2Client.session.remove.mockImplementation(async () => undefined);
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
        getProtocol: () => 'legacy',
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

  it('uses the generated V2 client and authoritative wait endpoint', async () => {
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
        getProtocol: () => 'opencode2',
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '2',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'V2 PR', body: 'V2 body' },
    });
    expect(createOpencodeClient).not.toHaveBeenCalled();
    expect(makeV2Client).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test' },
    });
    expect(v2Client.session.create).toHaveBeenCalledWith({
      location: { directory: '/repo' },
      title: 'Git Generation',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(v2Client.session.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_v2',
      text: expect.stringContaining('drafting a GitHub Pull Request'),
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(v2Client.session.wait).toHaveBeenCalledWith({ sessionID: 'ses_v2' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(v2Client.message.list).toHaveBeenCalledWith({
      sessionID: 'ses_v2',
      limit: 10,
      order: 'desc',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(v2Client.session.remove).toHaveBeenCalledWith({ sessionID: 'ses_v2' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
