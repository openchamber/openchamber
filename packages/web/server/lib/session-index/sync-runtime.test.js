import { describe, expect, it, vi } from 'vitest';

import { createSessionIndexSyncRuntime } from './sync-runtime.js';

const session = (id, updated, directory = '/repo') => ({
  id,
  title: id,
  directory,
  time: { created: updated, updated },
});

const createService = (initialDirectories = []) => {
  let directories = initialDirectories;
  return {
    getRuntimeKey: () => 'runtime-a',
    snapshot: () => ({ directories }),
    replaceDirectory: vi.fn((input) => {
      const next = {
        ...input,
        lastSyncedAt: input.now,
        lastFullSyncedAt: input.fullSync
          ? input.now
          : (directories.find((entry) => entry.directory === input.directory)?.lastFullSyncedAt ?? 0),
      };
      directories = [...directories.filter((entry) => entry.directory !== input.directory), next];
    }),
  };
};

const waitUntil = async (predicate) => {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition not reached');
};

describe('session index background sync runtime', () => {
  it('runs directory sync sequentially and publishes long-poll progress', async () => {
    const service = createService();
    let active = 0;
    let maxActive = 0;
    const fetchFn = vi.fn(async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      const directory = url.searchParams.get('directory');
      return new Response(JSON.stringify([session(`ses_${directory}`, 10, directory)]), { status: 200 });
    });
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
      waitForOpenCodeReady: async () => true,
      fetchFn,
    });

    const initial = runtime.enqueue(['/repo/a', '/repo/b']);
    const changed = await runtime.waitForChange(initial.revision);
    expect(changed.revision).toBeGreaterThan(initial.revision);
    await waitUntil(() => runtime.snapshot().sync.active === false);

    expect(maxActive).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0].pathname).toBe('/experimental/session');
    expect(service.replaceDirectory).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().sync).toMatchObject({ completed: 2, total: 2, failedDirectories: [] });
  });

  it('uses the persisted watermark for a true incremental merge', async () => {
    const service = createService([{
      directory: '/repo',
      sessions: [session('ses_old', 10)],
      cursor: 10,
      hasMore: true,
      lastSyncedAt: 1000,
      lastFullSyncedAt: 900,
    }]);
    let requestedUrl;
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: async (url) => {
        requestedUrl = url;
        return new Response(JSON.stringify([session('ses_new', 20)]), { status: 200 });
      },
      now: () => 2000,
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => runtime.snapshot().sync.active === false);

    expect(requestedUrl.searchParams.get('start')).toBe('1000');
    expect(service.replaceDirectory.mock.calls[0][0]).toMatchObject({
      fullSync: false,
      sessions: [expect.objectContaining({ id: 'ses_new' }), expect.objectContaining({ id: 'ses_old' })],
    });
  });

  it('preempts and resumes a background list when an interactive session read arrives', async () => {
    const service = createService();
    let calls = 0;
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: (_url, init) => {
        calls += 1;
        if (calls > 1) return Promise.resolve(new Response('[]', { status: 200 }));
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
      now: (() => { let value = 0; return () => { value += 1000; return value; }; })(),
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => calls === 1);
    runtime.noteInteractiveRequest();
    await waitUntil(() => runtime.snapshot().sync.active === false);

    expect(calls).toBe(2);
    expect(runtime.snapshot().sync.completed).toBe(1);
  });

  it('allows a later UI reload to enqueue the same directory as a new batch', async () => {
    const service = createService();
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200 }));
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn,
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => runtime.snapshot().sync.active === false);
    runtime.enqueue(['/repo']);
    await waitUntil(() => runtime.snapshot().sync.active === false);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
