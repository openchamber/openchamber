import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import { createCodexImportRuntime, formatCodexTranscript } from './runtime.js';

const createThread = (overrides = {}) => ({
  id: 'thread-1',
  name: 'Fix the build',
  preview: 'Fix the build',
  cwd: 'C:\\repo',
  createdAt: 100,
  updatedAt: 200,
  turns: [],
  ...overrides,
});

const createCodexClient = (threads, fullThreads = new Map()) => ({
  start: vi.fn(async () => {}),
  close: vi.fn(),
  request: vi.fn(async (method, params) => {
    if (method === 'config/read') {
      return {
        config: {
          model: 'gpt-5',
          model_provider: 'openai',
          projects: {
            'C:\\repo': { trust_level: 'trusted' },
          },
        },
      };
    }
    if (method === 'thread/list') {
      const archived = params.archived === true;
      return {
        data: threads.filter((thread) => Boolean(thread.archived) === archived),
        nextCursor: null,
      };
    }
    if (method === 'thread/read') {
      return { thread: fullThreads.get(params.threadId) || threads.find((thread) => thread.id === params.threadId) };
    }
    throw new Error(`Unexpected method: ${method}`);
  }),
});

const createDependencies = ({ threads, openCodeClient, projectRegistration = { added: 1, existing: 0, unavailable: 0 } }) => {
  const codexClient = createCodexClient(threads, new Map(threads.map((thread) => [thread.id, thread])));
  const registerProjects = vi.fn(async () => projectRegistration);
  return {
    codexClient,
    registerProjects,
    runtime: createCodexImportRuntime({
      spawn: vi.fn(),
      fsPromises: {
        stat: vi.fn(async () => ({ isDirectory: () => true })),
      },
      path: path.win32,
      registerProjects,
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
      getOpenCodeAuthHeaders: () => ({}),
      createCodexClient: () => codexClient,
      createOpenCodeClient: () => openCodeClient,
    }),
  };
};

describe('Codex import runtime', () => {
  it('formats supported conversation items without command output', () => {
    const transcript = formatCodexTranscript(createThread({
      turns: [{
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'Please fix it' }] },
          { type: 'agentMessage', text: 'Fixed.' },
          { type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'secret output' },
          { type: 'hookPrompt', prompt: 'internal prompt' },
        ],
      }],
    }));

    expect(transcript).toContain('## User\n\nPlease fix it');
    expect(transcript).toContain('## Codex\n\nFixed.');
    expect(transcript).toContain('npm test');
    expect(transcript).toContain('Unsupported item type: hookPrompt');
    expect(transcript).not.toContain('secret output');
    expect(transcript).not.toContain('internal prompt');
  });

  it('inspects active and archived threads and returns only safe config fields', async () => {
    const threads = [createThread(), createThread({ id: 'thread-2', archived: true })];
    const { runtime } = createDependencies({
      threads,
      openCodeClient: { session: {} },
    });

    const preview = await runtime.inspect();

    expect(preview.config).toEqual({
      model: 'gpt-5',
      modelProvider: 'openai',
      reasoningEffort: null,
      approvalPolicy: null,
      sandboxMode: null,
    });
    expect(preview.projects).toEqual([{
      path: 'C:\\repo',
      trustLevel: 'trusted',
      threadCount: 2,
      threadIds: ['thread-1', 'thread-2'],
      exists: true,
    }]);
    expect(preview.threads).toHaveLength(2);
  });

  it('imports a transcript, persists its project, and skips the same Codex thread on retry', async () => {
    const threads = [createThread({
      turns: [{ items: [{ type: 'agentMessage', text: 'Done' }] }],
    })];
    const openCodeClient = {
      session: {
        list: vi.fn(async () => ({ data: [] })),
        create: vi.fn(async () => ({ data: { id: 'session-1' } })),
        promptAsync: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
      },
    };
    const { runtime, registerProjects } = createDependencies({ threads, openCodeClient });

    const result = await runtime.apply({ threadIds: ['thread-1'], projectPaths: ['C:\\repo'] });

    expect(result.projectsAdded).toBe(1);
    expect(result.results).toEqual([{ threadId: 'thread-1', status: 'imported', sessionId: 'session-1' }]);
    expect(registerProjects).toHaveBeenCalledWith(['C:\\repo']);
    expect(openCodeClient.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'session-1', noReply: true }),
      { throwOnError: true },
    );

    openCodeClient.session.list.mockResolvedValueOnce({
      data: [{ id: 'session-1', metadata: { importSource: 'codex', importThreadID: 'thread-1' } }],
    });
    const retry = await runtime.apply({ threadIds: ['thread-1'], projectPaths: [] });
    expect(retry.results).toEqual([{ threadId: 'thread-1', status: 'skipped', sessionId: 'session-1' }]);
  });

  it('deletes the empty OpenCode session when transcript persistence fails', async () => {
    const threads = [createThread()];
    const openCodeClient = {
      session: {
        list: vi.fn(async () => ({ data: [] })),
        create: vi.fn(async () => ({ data: { id: 'session-1' } })),
        promptAsync: vi.fn(async () => { throw new Error('write failed'); }),
        delete: vi.fn(async () => ({})),
      },
    };
    const { runtime } = createDependencies({ threads, openCodeClient });

    const result = await runtime.apply({ threadIds: ['thread-1'], projectPaths: [] });

    expect(openCodeClient.session.delete).toHaveBeenCalledWith(
      { sessionID: 'session-1', directory: 'C:\\repo' },
      { throwOnError: true },
    );
    expect(result.results[0]).toEqual({ threadId: 'thread-1', status: 'failed', error: 'write failed' });
  });

  it('checks every OpenCode session page before creating an import session', async () => {
    const threads = [createThread()];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `session-${index}` }));
    const openCodeClient = {
      session: {
        list: vi.fn(async ({ start }) => ({
          data: start === 0
            ? firstPage
            : [{ id: 'imported-session', metadata: { importSource: 'codex', importThreadID: 'thread-1' } }],
        })),
        create: vi.fn(),
        promptAsync: vi.fn(),
        delete: vi.fn(),
      },
    };
    const { runtime } = createDependencies({ threads, openCodeClient });

    const result = await runtime.apply({ threadIds: ['thread-1'], projectPaths: [] });

    expect(openCodeClient.session.list).toHaveBeenCalledTimes(2);
    expect(openCodeClient.session.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: 100 }),
      { throwOnError: true },
    );
    expect(openCodeClient.session.create).not.toHaveBeenCalled();
    expect(result.results).toEqual([{ threadId: 'thread-1', status: 'skipped', sessionId: 'imported-session' }]);
  });

  it('serializes concurrent imports so the same Codex thread is created once', async () => {
    const threads = [createThread()];
    const sessions = [];
    const openCodeClient = {
      session: {
        list: vi.fn(async () => ({ data: [...sessions] })),
        create: vi.fn(async ({ metadata }) => {
          sessions.push({ id: 'session-1', metadata });
          return { data: { id: 'session-1' } };
        }),
        promptAsync: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
      },
    };
    const { runtime } = createDependencies({ threads, openCodeClient });

    const [first, second] = await Promise.all([
      runtime.apply({ threadIds: ['thread-1'], projectPaths: [] }),
      runtime.apply({ threadIds: ['thread-1'], projectPaths: [] }),
    ]);

    expect(openCodeClient.session.create).toHaveBeenCalledOnce();
    expect(first.results[0].status).toBe('imported');
    expect(second.results[0]).toEqual({ threadId: 'thread-1', status: 'skipped', sessionId: 'session-1' });
  });
});
