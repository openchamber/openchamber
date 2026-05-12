import { beforeEach, describe, expect, it, vi } from 'vitest';

const codexAppServerState = {
  listModels: vi.fn(),
  listThreads: vi.fn(),
  readThread: vi.fn(),
  getOrCreateProcess: vi.fn(),
  getThreadId: vi.fn(),
  startTurn: vi.fn(),
  abort: vi.fn(),
  shutdownSession: vi.fn(),
  rollbackTurns: vi.fn(),
  archiveThread: vi.fn(),
  unarchiveThread: vi.fn(),
  unsubscribeThread: vi.fn(),
  setThreadName: vi.fn(),
  shutdownAll: vi.fn(),
  hasPermissionRequest: vi.fn(),
  hasQuestionRequest: vi.fn(),
  replyToPermission: vi.fn(),
  replyToQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
  listPendingPermissions: vi.fn(),
  listPendingQuestions: vi.fn(),
};
let codexAdapterOptions = null;

vi.mock('./codex-appserver.js', () => ({
  createCodexAppServerAdapter: (options) => {
    codexAdapterOptions = options;
    return codexAppServerState;
  },
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
    codexAdapterOptions = null;
    codexAppServerState.listModels.mockResolvedValue([
      { id: 'gpt-5.5-mini', label: 'GPT 5.5 Mini' },
      { id: 'gpt-5.5', label: 'GPT 5.5', isDefault: true },
    ]);
    codexAppServerState.getThreadId.mockReturnValue('codex-thread-1');
    codexAppServerState.listThreads.mockResolvedValue([]);
    codexAppServerState.readThread.mockResolvedValue(null);
    codexAppServerState.getOrCreateProcess.mockResolvedValue(undefined);
    codexAppServerState.startTurn.mockResolvedValue(undefined);
    codexAppServerState.abort.mockResolvedValue(undefined);
    codexAppServerState.shutdownSession.mockResolvedValue(undefined);
    codexAppServerState.rollbackTurns.mockResolvedValue(undefined);
    codexAppServerState.archiveThread.mockResolvedValue(true);
    codexAppServerState.unarchiveThread.mockResolvedValue(true);
    codexAppServerState.unsubscribeThread.mockResolvedValue(true);
    codexAppServerState.setThreadName.mockResolvedValue(true);
    codexAppServerState.hasPermissionRequest.mockReturnValue(false);
    codexAppServerState.hasQuestionRequest.mockReturnValue(false);
    codexAppServerState.listPendingPermissions.mockReturnValue([]);
    codexAppServerState.listPendingQuestions.mockReturnValue([]);
  });

  it('persists completed assistant turns with the live streaming message id', async () => {
    const { runtime } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo' });

    await runtime.promptAsync({
      sessionID: session.id,
      messageID: 'msg-user-1',
      parts: [{ type: 'text', text: 'Build it' }],
    });

    const assistantRecord = codexAppServerState.startTurn.mock.calls[0][2];
    await codexAdapterOptions.onTurnCompleted(session.id, 'Done.', {
      messageId: assistantRecord.info.id,
      parentMessageId: 'msg-user-1',
    }, [
      { type: 'text', text: 'Done.' },
    ]);

    const records = await runtime.getMessages({ sessionID: session.id });
    expect(records).toHaveLength(2);
    expect(records[1].info).toEqual(expect.objectContaining({
      id: assistantRecord.info.id,
      role: 'assistant',
      parentID: 'msg-user-1',
    }));
    expect(records[1].parts[0]).toEqual(expect.objectContaining({
      messageID: assistantRecord.info.id,
      text: 'Done.',
    }));
  });

  it('keeps live Codex part ids in persisted assistant records for reload parity', async () => {
    const { runtime } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo' });

    await runtime.promptAsync({
      sessionID: session.id,
      messageID: 'msg-user-1',
      parts: [{ type: 'text', text: 'Build it' }],
    });

    const assistantRecord = codexAppServerState.startTurn.mock.calls[0][2];
    await codexAdapterOptions.onTurnCompleted(session.id, 'Done.', {
      messageId: assistantRecord.info.id,
      parentMessageId: 'msg-user-1',
    }, [
      {
        id: `${assistantRecord.info.id}_000001_reasoning_reason-1`,
        type: 'reasoning',
        text: 'Thinking',
        time: { start: 1, end: 2 },
      },
      {
        id: `${assistantRecord.info.id}_000002_tool-output_cmd-1`,
        type: 'tool',
        tool: 'bash',
        callID: `${assistantRecord.info.id}_000002_tool-output_cmd-1`,
        state: {
          status: 'completed',
          output: 'ok',
          input: { command: 'bun test' },
          time: { start: 3, end: 4 },
        },
      },
      {
        id: `${assistantRecord.info.id}_000003_text_text-1`,
        type: 'text',
        text: 'Done.',
      },
    ]);

    const records = await runtime.getMessages({ sessionID: session.id });
    const persistedAssistant = records[1];
    expect(persistedAssistant.parts.map((part) => part.id)).toEqual([
      `${assistantRecord.info.id}_000001_reasoning_reason-1`,
      `${assistantRecord.info.id}_000002_tool-output_cmd-1`,
      `${assistantRecord.info.id}_000003_text_text-1`,
    ]);
    expect(persistedAssistant.parts[1].callID).toBe(`${assistantRecord.info.id}_000002_tool-output_cmd-1`);
  });

  it('normalizes legacy Codex assistant part ids on read to stable sortable order', async () => {
    const { runtime } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo' });

    await runtime.promptAsync({
      sessionID: session.id,
      messageID: 'msg-user-1',
      parts: [{ type: 'text', text: 'Build it' }],
    });

    const assistantRecord = codexAppServerState.startTurn.mock.calls[0][2];
    await codexAdapterOptions.onTurnCompleted(session.id, 'Done.', {
      messageId: assistantRecord.info.id,
      parentMessageId: 'msg-user-1',
    }, [
      { type: 'reasoning', text: 'Thinking', time: { start: 1, end: 2 } },
      {
        type: 'tool',
        tool: 'bash',
        callID: 'legacy-call',
        state: {
          status: 'completed',
          output: 'ok',
          input: { command: 'bun test' },
          time: { start: 3, end: 4 },
        },
      },
      { type: 'text', text: 'Done.' },
    ]);

    const records = await runtime.getMessages({ sessionID: session.id });
    const persistedAssistant = records[1];
    expect(persistedAssistant.parts[0].id).toContain(`${assistantRecord.info.id}_000001_reasoning_`);
    expect(persistedAssistant.parts[1].id).toContain(`${assistantRecord.info.id}_000002_tool-output_`);
    expect(persistedAssistant.parts[2].id).toContain(`${assistantRecord.info.id}_000003_text_`);
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
        source: 'provider-snapshot',
        providerId: 'codex',
        defaultOptionId: 'gpt-5.5',
      },
      effortSelector: {
        label: 'Thinking',
        source: 'provider-option',
        optionId: 'effort',
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

  it('hydrates listSessions from Codex thread/list for matching directory', async () => {
    const { runtime } = createRuntime();
    codexAppServerState.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-external-1',
        cwd: '/repo',
        name: 'External Codex session',
        preview: 'Preview text',
        createdAt: 1,
        updatedAt: 2,
        status: { type: 'idle' },
      },
    ]);

    const sessions = await runtime.listSessions({ directory: '/repo' });

    expect(codexAppServerState.listThreads).toHaveBeenCalledWith({ cwd: '/repo', archived: false });
    expect(sessions.some((session) => session.title === 'External Codex session')).toBe(true);
    const hydrated = sessions.find((session) => session.title === 'External Codex session');
    expect(hydrated?.backendId).toBe('codex');
    expect(hydrated?.directory).toBe('/repo');
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

  it('archives Codex thread via app-server before marking session archived', async () => {
    const { runtime } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo' });

    await runtime.updateSession({
      sessionID: session.id,
      time: { archived: 12345 },
    });

    expect(codexAppServerState.archiveThread).toHaveBeenCalledWith(session.id, {
      directory: '/repo',
      threadId: null,
    });
  });

  it('renames Codex thread via app-server before updating local session title', async () => {
    const { runtime } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo', title: 'Old title' });

    await runtime.updateSession({
      sessionID: session.id,
      title: 'New title',
    });

    expect(codexAppServerState.setThreadName).toHaveBeenCalledWith(session.id, 'New title', {
      directory: '/repo',
      threadId: null,
    });
    const sessions = await runtime.listSessions({ directory: '/repo' });
    expect(sessions.find((item) => item.id === session.id)?.title).toBe('New title');
  });

  it('does not downgrade session updated time after rename when thread/list is stale', async () => {
    const { runtime } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo', title: 'Old title' });

    await runtime.updateSession({
      sessionID: session.id,
      title: 'New title',
    });

    const renamed = await runtime.getSession({ sessionID: session.id });
    expect(typeof renamed?.time?.updated).toBe('number');

    codexAppServerState.listThreads.mockResolvedValueOnce([
      {
        id: 'codex-thread-1',
        cwd: '/repo',
        name: 'New title',
        createdAt: 1,
        updatedAt: 2,
        status: { type: 'idle' },
      },
    ]);

    const sessions = await runtime.listSessions({ directory: '/repo' });
    const hydrated = sessions.find((item) => item.id === session.id);
    expect(hydrated?.title).toBe('New title');
    expect((hydrated?.time?.updated ?? 0) >= (renamed?.time?.updated ?? 0)).toBe(true);
  });

  it('archives and unsubscribes Codex thread before local delete', async () => {
    const { runtime } = createRuntime();
    const session = await runtime.createSession({ directory: '/repo' });

    await expect(runtime.deleteSession({ sessionID: session.id })).resolves.toBe(true);

    expect(codexAppServerState.archiveThread).toHaveBeenCalledWith(session.id, {
      directory: '/repo',
      threadId: null,
    });
    expect(codexAppServerState.unsubscribeThread).toHaveBeenCalledWith(session.id, {
      directory: '/repo',
      threadId: null,
    });
    expect(codexAppServerState.shutdownSession).toHaveBeenCalledWith(session.id);
  });
});
