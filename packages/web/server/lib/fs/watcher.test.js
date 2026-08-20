import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFsWatcherRuntime } from './watcher.js';

const createWatchHarness = () => {
  const registrations = [];
  const watch = vi.fn((directory, options, listener) => {
    const handlers = new Map();
    const watcher = {
      close: vi.fn(),
      on: vi.fn((event, handler) => {
        handlers.set(event, handler);
        return watcher;
      }),
    };
    registrations.push({ directory, options, listener, handlers, watcher });
    return watcher;
  });
  return { registrations, watch };
};

describe('fs watcher runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one watcher and batches directory invalidations in each requested path space', async () => {
    vi.useFakeTimers();
    const harness = createWatchHarness();
    const runtime = createFsWatcherRuntime({
      watch: harness.watch,
      path: path.posix,
      debounceMs: 250,
    });
    const firstEvents = [];
    const secondEvents = [];

    const first = runtime.subscribe({
      canonicalDirectory: '/real/project/src',
      requestedDirectory: '/project/src',
      onChange: (event) => firstEvents.push(event),
    });
    const second = runtime.subscribe({
      canonicalDirectory: '/real/project/src',
      requestedDirectory: '/linked/src',
      onChange: (event) => secondEvents.push(event),
    });

    expect(harness.watch).toHaveBeenCalledTimes(1);
    expect(harness.watch).toHaveBeenCalledWith(
      '/real/project/src',
      { persistent: false },
      expect.any(Function),
    );

    harness.registrations[0].listener('rename', 'new-file.ts');
    harness.registrations[0].listener('change', 'changed-file.ts');
    harness.registrations[0].listener('change', 'changed-file.ts');

    await vi.advanceTimersByTimeAsync(249);
    expect(firstEvents).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(firstEvents).toEqual([{ directory: '/project/src' }]);
    expect(secondEvents).toEqual([{ directory: '/linked/src' }]);

    first.close();
    expect(harness.registrations[0].watcher.close).not.toHaveBeenCalled();
    second.close();
    expect(harness.registrations[0].watcher.close).toHaveBeenCalledTimes(1);
  });

  it('shares Windows watcher identities case-insensitively, including UNC paths', () => {
    const harness = createWatchHarness();
    const runtime = createFsWatcherRuntime({
      watch: harness.watch,
      path: path.win32,
      platform: 'win32',
    });

    const first = runtime.subscribe({
      canonicalDirectory: '\\\\Server\\Share\\Repo',
      requestedDirectory: '\\\\Server\\Share\\Repo',
      onChange: () => undefined,
    });
    const second = runtime.subscribe({
      canonicalDirectory: '\\\\server\\share\\repo',
      requestedDirectory: '\\\\server\\share\\repo',
      onChange: () => undefined,
    });

    expect(harness.watch).toHaveBeenCalledTimes(1);
    first.close();
    expect(harness.registrations[0].watcher.close).not.toHaveBeenCalled();
    second.close();
    expect(harness.registrations[0].watcher.close).toHaveBeenCalledTimes(1);
  });

  it('keeps case-distinct POSIX directories as separate watcher identities', () => {
    const harness = createWatchHarness();
    const runtime = createFsWatcherRuntime({
      watch: harness.watch,
      path: path.posix,
      platform: 'darwin',
    });

    runtime.subscribe({
      canonicalDirectory: '/Users/me/Repo',
      requestedDirectory: '/Users/me/Repo',
      onChange: () => undefined,
    });
    runtime.subscribe({
      canonicalDirectory: '/Users/me/repo',
      requestedDirectory: '/Users/me/repo',
      onChange: () => undefined,
    });

    expect(harness.watch).toHaveBeenCalledTimes(2);
  });

  it('invalidates the watched directory when the platform omits a filename', async () => {
    vi.useFakeTimers();
    const harness = createWatchHarness();
    const runtime = createFsWatcherRuntime({
      watch: harness.watch,
      path: path.posix,
      debounceMs: 250,
    });
    const events = [];

    const subscription = runtime.subscribe({
      canonicalDirectory: '/repo',
      requestedDirectory: '/repo',
      onChange: (event) => events.push(event),
    });
    harness.registrations[0].listener('rename', null);

    await vi.advanceTimersByTimeAsync(250);
    expect(events).toEqual([{ directory: '/repo' }]);

    subscription.close();
  });

  it('flushes a continuous event stream within the maximum batch delay', async () => {
    vi.useFakeTimers();
    const harness = createWatchHarness();
    const runtime = createFsWatcherRuntime({
      watch: harness.watch,
      path: path.posix,
      debounceMs: 250,
      maxWaitMs: 1000,
    });
    const events = [];

    runtime.subscribe({
      canonicalDirectory: '/repo',
      requestedDirectory: '/repo',
      onChange: (event) => events.push(event),
    });

    harness.registrations[0].listener('change', 'file-0.ts');
    for (let index = 1; index <= 4; index += 1) {
      await vi.advanceTimersByTimeAsync(200);
      harness.registrations[0].listener('change', `file-${index}.ts`);
    }
    await vi.advanceTimersByTimeAsync(199);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([{ directory: '/repo' }]);
  });

  it('closes an entry once when an error callback closes its subscription', () => {
    const harness = createWatchHarness();
    const runtime = createFsWatcherRuntime({ watch: harness.watch, path: path.posix });
    let subscription;
    subscription = runtime.subscribe({
      canonicalDirectory: '/repo',
      requestedDirectory: '/repo',
      onChange: () => undefined,
      onError: () => subscription.close(),
    });

    harness.registrations[0].handlers.get('error')(Object.assign(new Error('deleted'), { code: 'EPERM' }));

    expect(harness.registrations[0].watcher.close).toHaveBeenCalledTimes(1);
  });
});
