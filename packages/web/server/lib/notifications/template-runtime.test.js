import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (settings = {}) => createNotificationTemplateRuntime({
  readSettingsFromDisk: async () => settings,
  persistSettings: vi.fn(async () => {}),
  buildOpenCodeUrl: (path) => path,
  getOpenCodeAuthHeaders: () => ({}),
  resolveGitBinaryForSpawn: () => 'git',
});

describe('notification template runtime zen models', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns no selectable zen models after provider retirement', async () => {
    const runtime = createRuntime();
    const models = await runtime.fetchFreeZenModels();

    expect(models).toEqual([]);
  });

  it('preserves stored zen model value for compatibility without validation', async () => {
    const runtime = createRuntime({ zenModel: 'trinity-large-preview-free' });

    await expect(runtime.resolveZenModel()).resolves.toBe('trinity-large-preview-free');
  });
});

describe('notification template message extraction', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('excludes reasoning parts from payload message text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { type: 'reasoning', text: 'private chain of thought' },
            { type: 'text', text: 'final answer' },
          ],
        },
      },
    })).toBe('final answer');
  });

  it('ignores untyped parts even when they contain text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { text: 'untyped text' },
            { content: 'untyped content' },
            { type: 'text', text: 'typed final answer' },
          ],
        },
      },
    })).toBe('typed final answer');
  });

  it('excludes reasoning parts when fetching assistant messages', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      {
        info: { id: 'msg-1', role: 'assistant', finish: 'stop' },
        parts: [
          { type: 'reasoning', text: 'private chain of thought' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ])));

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'msg-1')).resolves.toBe('final answer');
  });

  it('uses the coordinated light status lookup for notification branches', async () => {
    const getStatus = vi.fn(async () => ({ current: 'feature/notifications' }));
    const runtime = createNotificationTemplateRuntime({
      readSettingsFromDisk: async () => ({ projects: [{ path: '/repo', label: 'Repository' }] }),
      buildOpenCodeUrl: (path) => path,
      getOpenCodeAuthHeaders: () => ({}),
      gitExecutionService: { getStatus },
    });

    await expect(runtime.buildTemplateVariables({
      properties: {
        sessionTitle: 'Session',
        info: { path: { root: '/repo' } },
      },
    }, 'session-1')).resolves.toMatchObject({
      project_name: 'Repository',
      branch: 'feature/notifications',
    });
    expect(getStatus).toHaveBeenCalledWith('/repo', expect.objectContaining({
      mode: 'light',
      queueTimeoutMs: 3000,
      signal: expect.any(AbortSignal),
    }));
  });

  it('leaves branch enrichment empty when coordinated status reports a non-repository', async () => {
    const getStatus = vi.fn(async () => ({ isGitRepository: false, current: '' }));
    const runtime = createNotificationTemplateRuntime({
      readSettingsFromDisk: async () => ({ projects: [{ path: '/repo', label: 'Repository' }] }),
      buildOpenCodeUrl: (path) => path,
      getOpenCodeAuthHeaders: () => ({}),
      gitExecutionService: { getStatus },
    });

    await expect(runtime.buildTemplateVariables({
      properties: { info: { path: { root: '/repo' } } },
    }, 'session-1')).resolves.toMatchObject({
      project_name: 'Repository',
      branch: '',
    });
  });

  it('leaves branch enrichment empty when coordinated status fails', async () => {
    const getStatus = vi.fn(async () => { throw new Error('Git execution failed'); });
    const runtime = createNotificationTemplateRuntime({
      readSettingsFromDisk: async () => ({ projects: [{ path: '/repo', label: 'Repository' }] }),
      buildOpenCodeUrl: (path) => path,
      getOpenCodeAuthHeaders: () => ({}),
      gitExecutionService: { getStatus },
    });

    await expect(runtime.buildTemplateVariables({
      properties: { info: { path: { root: '/repo' } } },
    }, 'session-1')).resolves.toMatchObject({ branch: '' });
  });

  it('does not require the Git execution service for notification templates', async () => {
    const runtime = createRuntime({ projects: [{ path: '/repo', label: 'Repository' }] });

    await expect(runtime.buildTemplateVariables({
      properties: { info: { path: { root: '/repo' } } },
    }, 'session-1')).resolves.toMatchObject({
      project_name: 'Repository',
      branch: '',
    });
  });

  it('times out a stalled coordinated status lookup and aborts its waiter', async () => {
    vi.useFakeTimers();
    try {
      let signal;
      const getStatus = vi.fn(async (_directory, options) => {
        signal = options.signal;
        return new Promise(() => {});
      });
      const runtime = createNotificationTemplateRuntime({
        readSettingsFromDisk: async () => ({ projects: [{ path: '/repo', label: 'Repository' }] }),
        buildOpenCodeUrl: (path) => path,
        getOpenCodeAuthHeaders: () => ({}),
        gitExecutionService: { getStatus },
      });

      const pending = runtime.buildTemplateVariables({
        properties: {
          sessionTitle: 'Session',
          info: { path: { root: '/repo' } },
        },
      }, 'session-1');
      for (let attempt = 0; attempt < 5 && !getStatus.mock.calls.length; attempt += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(3000);

      await expect(pending).resolves.toMatchObject({ branch: '' });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
