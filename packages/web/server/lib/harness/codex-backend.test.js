import { beforeEach, describe, expect, it, vi } from 'vitest';

const codexAppServerState = {
  listModels: vi.fn(),
  getOrCreateProcess: vi.fn(),
  getThreadId: vi.fn(),
  startTurn: vi.fn(),
  abort: vi.fn(),
  shutdownSession: vi.fn(),
  rollbackTurns: vi.fn(),
  shutdownAll: vi.fn(),
  hasPermissionRequest: vi.fn(),
  hasQuestionRequest: vi.fn(),
  replyToPermission: vi.fn(),
  replyToQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
  listPendingPermissions: vi.fn(),
  listPendingQuestions: vi.fn(),
};

vi.mock('./codex-appserver.js', () => ({
  createCodexAppServerAdapter: () => codexAppServerState,
}));

const { createCodexBackendRuntime } = await import('./codex-backend.js');

const createDeterministicCrypto = () => {
  let counter = 0;
  return {
    randomBytes(size) {
      counter += 1;
      return Buffer.alloc(size, counter);
    },
    randomInt(_min, max) {
      counter += 1;
      return counter % max;
    },
  };
};

const createMemoryFs = () => {
  let stored = null;
  const writes = [];
  return {
    fsPromises: {
      async readFile(filePath) {
        if (String(filePath).endsWith('/prompts')) {
          const error = new Error('not found');
          error.code = 'ENOENT';
          throw error;
        }
        if (stored === null) {
          const error = new Error('not found');
          error.code = 'ENOENT';
          throw error;
        }
        return stored;
      },
      async readdir() {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      },
      async mkdir() {},
      async writeFile(_filePath, contents) {
        stored = contents;
        writes.push(JSON.parse(contents));
      },
    },
    getStored: () => stored,
    writes,
  };
};

const createRuntime = () => {
  const events = [];
  const memoryFs = createMemoryFs();
  const runtime = createCodexBackendRuntime({
    crypto: createDeterministicCrypto(),
    fsPromises: memoryFs.fsPromises,
    sessionsFilePath: '/tmp/openchamber-codex-sessions.json',
    publishEvent: (event) => events.push(event),
  });
  return { runtime, events, memoryFs };
};

describe('Codex backend runtime baseline contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codexAppServerState.listModels.mockResolvedValue([
      { id: 'gpt-5.5-mini', label: 'GPT 5.5 Mini' },
      { id: 'gpt-5.5', label: 'GPT 5.5', isDefault: true },
    ]);
    codexAppServerState.getThreadId.mockReturnValue('codex-thread-1');
    codexAppServerState.getOrCreateProcess.mockResolvedValue(undefined);
    codexAppServerState.startTurn.mockResolvedValue(undefined);
    codexAppServerState.abort.mockResolvedValue(undefined);
    codexAppServerState.shutdownSession.mockResolvedValue(undefined);
    codexAppServerState.rollbackTurns.mockResolvedValue(undefined);
    codexAppServerState.hasPermissionRequest.mockReturnValue(false);
    codexAppServerState.hasQuestionRequest.mockReturnValue(false);
    codexAppServerState.listPendingPermissions.mockReturnValue([]);
    codexAppServerState.listPendingQuestions.mockReturnValue([]);
  });

  it('creates, persists, lists, and announces Codex sessions with OpenCode-compatible metadata', async () => {
    const { runtime, events, memoryFs } = createRuntime();

    const session = await runtime.createSession({ directory: '/repo/', title: 'Codex worktree' });
    const listed = await runtime.listSessions({ directory: '/repo' });

    expect(session).toEqual(expect.objectContaining({
      title: 'Codex worktree',
      directory: '/repo',
      parentID: null,
      backendId: 'codex',
      share: null,
    }));
    expect(listed).toEqual([session]);
    expect(memoryFs.writes.at(-1).sessions[0]).toEqual(expect.objectContaining({
      mode: 'build',
      modelId: 'gpt-5.5',
      effort: 'medium',
      records: [],
    }));
    expect(events).toHaveLength(0);
  });

  it('uses Codex model/list for controls and refuses an empty model catalog', async () => {
    const { runtime } = createRuntime();

    const surface = await runtime.getControlSurface();

    expect(surface).toMatchObject({
      backendId: 'codex',
      modelSelector: {
        source: 'backend',
        providerId: 'codex',
        defaultOptionId: 'gpt-5.5',
      },
      effortSelector: {
        label: 'Thinking',
        defaultOptionId: 'medium',
      },
    });
    expect(surface.modelSelector.options).toEqual([
      { id: 'gpt-5.5-mini', label: 'GPT 5.5 Mini' },
      { id: 'gpt-5.5', label: 'GPT 5.5' },
    ]);

    codexAppServerState.listModels.mockResolvedValueOnce([]);
    await expect(runtime.getControlSurface()).rejects.toThrow('Codex model list is empty');
  });

  it('persists user sends and emits OpenCode-compatible message/session/status events', async () => {
    const { runtime, events, memoryFs } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo' });

    await runtime.promptAsync({
      sessionID: session.id,
      messageID: 'msg-user-1',
      agent: 'plan',
      variant: 'high',
      model: { providerID: 'codex', modelID: 'gpt-5.5' },
      parts: [
        { type: 'text', text: 'Plan the refactor' },
      ],
    });

    const records = await runtime.getMessages({ sessionID: session.id });
    expect(records).toHaveLength(1);
    expect(records[0].info).toEqual(expect.objectContaining({
      id: 'msg-user-1',
      sessionID: session.id,
      role: 'user',
      agent: 'plan',
      mode: 'plan',
      variant: 'high',
      providerID: 'codex',
      modelID: 'gpt-5.5',
      model: {
        providerID: 'codex',
        modelID: 'gpt-5.5',
      },
    }));
    expect(records[0].parts[0]).toEqual(expect.objectContaining({
      sessionID: session.id,
      messageID: 'msg-user-1',
      type: 'text',
      text: 'Plan the refactor',
    }));
    expect(memoryFs.writes.at(-1).sessions[0]).toEqual(expect.objectContaining({
      mode: 'plan',
      modelId: 'gpt-5.5',
      effort: 'high',
      threadId: 'codex-thread-1',
    }));
    expect(codexAppServerState.getOrCreateProcess).toHaveBeenCalledWith(session.id, '/repo', {
      model: 'gpt-5.5',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      threadId: null,
    });
    expect(codexAppServerState.startTurn).toHaveBeenCalledWith(
      session.id,
      [{ type: 'text', text: 'Plan the refactor', text_elements: [] }],
      expect.objectContaining({
        info: expect.objectContaining({
          role: 'assistant',
          parentID: 'msg-user-1',
          providerID: 'codex',
          modelID: 'gpt-5.5',
          variant: 'high',
        }),
      }),
      { model: 'gpt-5.5', effort: 'high', mode: 'plan' },
    );
    expect(events.map((event) => event.payload.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'session.status',
    ]);
  });

  it('aborts a running Codex session and emits idle status', async () => {
    const { runtime, events } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo' });

    await runtime.promptAsync({
      sessionID: session.id,
      parts: [{ type: 'text', text: 'Build it' }],
    });
    events.length = 0;

    await expect(runtime.abortSession({ sessionID: session.id })).resolves.toBe(true);

    expect(codexAppServerState.abort).toHaveBeenCalledWith(session.id);
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        type: 'session.status',
        properties: expect.objectContaining({
          sessionID: session.id,
          status: { type: 'idle' },
        }),
      }),
      expect.objectContaining({
        type: 'session.idle',
        properties: expect.objectContaining({ sessionID: session.id }),
      }),
    ]);
  });
});
