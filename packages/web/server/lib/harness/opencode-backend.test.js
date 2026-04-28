import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkState = {
  clients: [],
  nextClient: null,
};

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: (options) => {
    const client = sdkState.nextClient;
    if (!client) {
      throw new Error('No mocked OpenCode client configured');
    }
    sdkState.clients.push({ options, client });
    return client;
  },
}));

const { createOpenCodeBackendRuntime } = await import('./opencode-backend.js');

const createMockClient = () => ({
  session: {
    create: vi.fn(),
    prompt: vi.fn(),
    promptAsync: vi.fn(),
    command: vi.fn(),
    abort: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    fork: vi.fn(),
    share: vi.fn(),
    unshare: vi.fn(),
    revert: vi.fn(),
    unrevert: vi.fn(),
  },
  app: {
    agents: vi.fn(),
  },
  config: {
    providers: vi.fn(),
  },
  command: {
    list: vi.fn(),
  },
  permission: {
    reply: vi.fn(),
  },
  question: {
    reply: vi.fn(),
    reject: vi.fn(),
  },
});

const createRuntime = (client = createMockClient()) => {
  sdkState.nextClient = client;
  const runtime = createOpenCodeBackendRuntime({
    buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test-token' }),
  });
  return { runtime, client };
};

describe('OpenCode backend runtime baseline contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkState.clients.length = 0;
    sdkState.nextClient = null;
  });

  it('creates scoped SDK clients with auth headers and forwards session creation payloads', async () => {
    const { runtime, client } = createRuntime();
    client.session.create.mockResolvedValue({
      data: { id: 'session-1', title: 'Work' },
    });

    const session = await runtime.createSession({
      directory: '/repo/',
      title: 'Work',
      parentID: 'parent-1',
    });

    expect(session).toEqual({ id: 'session-1', title: 'Work' });
    expect(sdkState.clients.at(-1).options).toEqual({
      baseUrl: 'http://127.0.0.1:4096',
      headers: { authorization: 'Bearer test-token' },
      directory: '/repo/',
    });
    expect(client.session.create).toHaveBeenCalledWith({
      title: 'Work',
      parentID: 'parent-1',
    }, {
      throwOnError: true,
    });
  });

  it('forwards prompt, command, abort, update, fork, share, and revert calls using OpenCode payload names', async () => {
    const { runtime, client } = createRuntime();
    client.session.promptAsync.mockResolvedValue({ data: { ok: true } });
    client.session.command.mockResolvedValue({ data: { ok: true } });
    client.session.abort.mockResolvedValue({ data: true });
    client.session.update.mockResolvedValue({ data: { id: 'session-1', title: 'Renamed' } });
    client.session.delete.mockResolvedValue({ data: true });
    client.session.fork.mockResolvedValue({ data: { id: 'session-2', parentID: 'session-1' } });
    client.session.share.mockResolvedValue({ data: { id: 'session-1', share: { url: 'https://share.example/session-1' } } });
    client.session.unshare.mockResolvedValue({ data: { id: 'session-1', share: null } });
    client.session.revert.mockResolvedValue({ data: { id: 'session-1', revert: { messageID: 'message-1' } } });
    client.session.unrevert.mockResolvedValue({ data: { id: 'session-1' } });

    await runtime.promptAsync({
      directory: '/repo',
      sessionID: 'session-1',
      messageID: 'message-1',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      agent: 'build',
      variant: 'high',
      parts: [{ type: 'text', text: 'Hello' }],
    });
    await runtime.command({
      directory: '/repo',
      sessionID: 'session-1',
      messageID: 'message-2',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      agent: 'build',
      variant: 'high',
      command: 'test',
      arguments: '--watch=false',
      parts: [{ type: 'text', text: '/test' }],
    });
    await runtime.abortSession({ sessionID: 'session-1' });
    await runtime.updateSession({ sessionID: 'session-1', title: 'Renamed', time: { archived: 123 } });
    await runtime.deleteSession({ sessionID: 'session-1' });
    await runtime.forkSession({ sessionID: 'session-1', messageID: 'message-1' });
    await runtime.shareSession({ sessionID: 'session-1' });
    await runtime.unshareSession({ sessionID: 'session-1' });
    await runtime.revertSession({ sessionID: 'session-1', messageID: 'message-1', partID: 'part-1' });
    await runtime.unrevertSession({ sessionID: 'session-1' });

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'session-1',
      messageID: 'message-1',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      agent: 'build',
      variant: 'high',
      parts: [{ type: 'text', text: 'Hello' }],
    }, { throwOnError: true });
    expect(client.session.command).toHaveBeenCalledWith({
      sessionID: 'session-1',
      messageID: 'message-2',
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      command: 'test',
      arguments: '--watch=false',
      variant: 'high',
      parts: [{ type: 'text', text: '/test' }],
    }, { throwOnError: true });
    expect(client.session.abort).toHaveBeenCalledWith({ sessionID: 'session-1' }, { throwOnError: true });
    expect(client.session.update).toHaveBeenCalledWith({
      sessionID: 'session-1',
      title: 'Renamed',
      time: { archived: 123 },
    }, { throwOnError: true });
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: 'session-1' }, { throwOnError: true });
    expect(client.session.fork).toHaveBeenCalledWith({
      sessionID: 'session-1',
      messageID: 'message-1',
    }, { throwOnError: true });
    expect(client.session.share).toHaveBeenCalledWith({ sessionID: 'session-1' }, { throwOnError: true });
    expect(client.session.unshare).toHaveBeenCalledWith({ sessionID: 'session-1' }, { throwOnError: true });
    expect(client.session.revert).toHaveBeenCalledWith({
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
    }, { throwOnError: true });
    expect(client.session.unrevert).toHaveBeenCalledWith({ sessionID: 'session-1' }, { throwOnError: true });
  });

  it('forwards blocking request replies through OpenCode payload names', async () => {
    const { runtime, client } = createRuntime();
    client.permission.reply.mockResolvedValue({ data: true });
    client.question.reply.mockResolvedValue({ data: true });
    client.question.reject.mockResolvedValue({ data: true });

    await runtime.replyToPermission('perm-1', 'once', { directory: '/repo' });
    await runtime.replyToQuestion('question-1', [['yes']], { directory: '/repo' });
    await runtime.rejectQuestion('question-2', { directory: '/repo' });

    expect(client.permission.reply).toHaveBeenCalledWith({
      requestID: 'perm-1',
      reply: 'once',
      directory: '/repo',
    }, { throwOnError: true });
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'question-1',
      answers: [['yes']],
      directory: '/repo',
    }, { throwOnError: true });
    expect(client.question.reject).toHaveBeenCalledWith({
      requestID: 'question-2',
      directory: '/repo',
    }, { throwOnError: true });
  });

  it('maps OpenCode agents, providers, model variants, and commands to a control surface', async () => {
    const { runtime, client } = createRuntime();
    client.app.agents.mockResolvedValue({
      data: [
        { name: 'build', description: 'Build things', color: 'blue' },
        { name: 'hidden', hidden: true },
        { name: 'sub', mode: 'subagent' },
      ],
    });
    client.config.providers.mockResolvedValue({
      data: {
        default: { chat: 'openai' },
        providers: {
          openai: {
            models: {
              'gpt-5': {
                name: 'GPT 5',
                variants: {
                  high: {},
                  low: {},
                },
              },
            },
          },
        },
      },
    });
    client.command.list.mockResolvedValue({
      data: [
        { name: 'test', description: 'Run tests' },
      ],
    });

    const surface = await runtime.getControlSurface({ directory: '/repo' });

    expect(surface).toEqual(expect.objectContaining({
      backendId: 'opencode',
      modeSelector: {
        kind: 'agent',
        label: 'Agent',
        items: [
          { id: 'build', label: 'Build', description: 'Build things', color: 'blue' },
        ],
      },
      modelSelector: {
        label: 'Model',
        source: 'provider-snapshot',
      },
      effortSelector: {
        label: 'Thinking',
        source: 'model-variants',
        defaultOptionId: null,
        options: [
          { id: 'high', label: 'High' },
          { id: 'low', label: 'Low' },
        ],
      },
      commandSelector: {
        source: 'config',
        items: [
          { name: 'test', description: 'Run tests', executionMode: 'session-command' },
        ],
      },
    }));
  });
});
