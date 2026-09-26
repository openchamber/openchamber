import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createGitIgnoreReader } from './gitignore.js';
import { createFsSearchRuntime } from './search.js';
import {
  createGitExecutionCoordinator,
  GIT_OPERATION_KIND,
} from '../git/execution-coordinator.js';

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('web Gitignore reader', () => {
  it('coordinates check-ignore and preserves the no-match exit contract', async () => {
    const child = createChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    const run = vi.fn(async (_directory, task, options) => {
      expect(options.queueTimeoutMs).toBe(25);
      return task();
    });
    const reader = createGitIgnoreReader({
      spawn,
      resolveGitBinaryForSpawn: () => 'git',
      gitExecutionService: { withRawRead: run },
      timeoutMs: 25,
    });

    await expect(reader.getIgnoredNames('/repo', ['README.md'])).resolves.toEqual(new Set());
    expect(run).toHaveBeenCalledWith('/repo', expect.any(Function), expect.objectContaining({ queueTimeoutMs: 25 }));
    expect(spawn).toHaveBeenCalledWith('git', ['check-ignore', '-z', '--', 'README.md'], expect.objectContaining({ cwd: '/repo' }));
  });

  it('returns ignored names and treats non-repositories as unfiltered', async () => {
    const children = [createChild(), createChild()];
    let index = 0;
    const spawn = vi.fn(() => {
      const child = children[index++];
      queueMicrotask(() => {
        if (index === 1) {
          child.stdout.emit('data', 'dist\0coverage\0');
          child.emit('close', 0);
        } else {
          child.stderr.emit('data', 'fatal: not a git repository');
          child.emit('close', 1);
        }
      });
      return child;
    });
    const reader = createGitIgnoreReader({ spawn, resolveGitBinaryForSpawn: () => 'git' });

    await expect(reader.getIgnoredNames('/repo', ['dist', 'coverage'])).resolves.toEqual(new Set(['dist', 'coverage']));
    await expect(reader.getIgnoredNames('/plain', ['README.md'])).resolves.toEqual(new Set());
  });

  it('preserves spaces and embedded newlines in NUL-delimited output', async () => {
    const child = createChild();
    const ignoredNames = [' leading space', 'trailing space ', 'line\nbreak'];
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', `${ignoredNames.join('\0')}\0`);
        child.emit('close', 0);
      });
      return child;
    });
    const reader = createGitIgnoreReader({ spawn, resolveGitBinaryForSpawn: () => 'git' });

    await expect(reader.getIgnoredNames('/repo', ignoredNames)).resolves.toEqual(new Set(ignoredNames));
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['check-ignore', '-z', '--', ...ignoredNames],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('kills a timed-out check-ignore process instead of leaking it', async () => {
    const child = createChild();
    const reader = createGitIgnoreReader({
      spawn: () => child,
      resolveGitBinaryForSpawn: () => 'git',
      timeoutMs: 1,
    });

    const pending = reader.getIgnoredNames('/repo', ['dist']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', null);
    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it('waits for Windows taskkill before settling a timed-out check-ignore', async () => {
    const child = createChild();
    child.pid = 1234;
    let taskkill;
    const spawn = vi.fn((command) => {
      if (command === 'taskkill') {
        taskkill = new EventEmitter();
        return taskkill;
      }
      return child;
    });
    const reader = createGitIgnoreReader({
      spawn,
      resolveGitBinaryForSpawn: () => 'git',
      platform: 'win32',
      timeoutMs: 1,
    });

    const pending = reader.getIgnoredNames('/repo', ['dist']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.emit('close', null);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(spawn).toHaveBeenLastCalledWith('taskkill', ['/pid', '1234', '/T', '/F'], expect.objectContaining({ windowsHide: true }));

    taskkill.emit('close', 0, null);
    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it('reports blocked cleanup when taskkill succeeds without a root close', async () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      child.pid = 1234;
      let taskkill;
      const spawn = vi.fn((command) => {
        if (command === 'taskkill') {
          taskkill = new EventEmitter();
          return taskkill;
        }
        return child;
      });
      const reader = createGitIgnoreReader({
        spawn,
        resolveGitBinaryForSpawn: () => 'git',
        platform: 'win32',
        timeoutMs: 1,
      });

      const pending = reader.getIgnoredNames('/repo', ['dist']);
      const outcome = pending.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(taskkill).toBeTruthy();
      taskkill.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(outcome).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'ERR_PROCESS_TREE_TERMINATION',
          descendantsTerminated: false,
          cleanupBlocked: true,
          rootClosed: false,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a Windows taskkill failure after caller cancellation', async () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      child.pid = 1237;
      let taskkill;
      const spawn = vi.fn((command) => {
        if (command === 'taskkill') {
          taskkill = new EventEmitter();
          return taskkill;
        }
        return child;
      });
      const reader = createGitIgnoreReader({
        spawn,
        resolveGitBinaryForSpawn: () => 'git',
        platform: 'win32',
        timeoutMs: 0,
      });
      const controller = new AbortController();
      const pending = reader.getIgnoredNames('/repo', ['dist'], { signal: controller.signal });

      controller.abort('caller cancelled');
      await Promise.resolve();
      expect(taskkill).toBeTruthy();
      taskkill.emit('error', new Error('taskkill unavailable'));
      child.emit('close', null);

      await expect(pending).rejects.toMatchObject({
        code: 'ERR_PROCESS_TREE_TERMINATION',
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for coordinated cleanup before exposing a delayed Windows failure', async () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      child.pid = 1238;
      let taskkill;
      const spawn = vi.fn((command) => {
        if (command === 'taskkill') {
          taskkill = new EventEmitter();
          return taskkill;
        }
        return child;
      });
      const coordinator = createGitExecutionCoordinator({ platform: 'win32' });
      const gitExecutionService = {
        withRawRead: (cwd, task, options) => coordinator.run({
          context: { isRepository: true, commonId: cwd, worktreeId: cwd },
          kind: GIT_OPERATION_KIND.READ,
          signal: options.signal,
          queueTimeoutMs: options.queueTimeoutMs,
          waitForCleanup: options.waitForCleanup,
        }, () => task()),
      };
      const reader = createGitIgnoreReader({
        spawn,
        resolveGitBinaryForSpawn: () => 'git',
        gitExecutionService,
        platform: 'win32',
        timeoutMs: 1,
      });
      const pending = reader.getIgnoredNames('/repo', ['dist']);
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(1);
      expect(taskkill).toBeTruthy();
      taskkill.emit('error', new Error('taskkill unavailable'));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).rejects.toMatchObject({
        code: 'ERR_PROCESS_TREE_TERMINATION',
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      expect(coordinator.getStats()).toMatchObject({ active: 1, pending: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves permission failures instead of treating them as no matches', async () => {
    const child = createChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', 'permission denied');
        child.emit('close', 1);
      });
      return child;
    });
    const reader = createGitIgnoreReader({ spawn, resolveGitBinaryForSpawn: () => 'git' });

    await expect(reader.getIgnoredNames('/repo', ['protected'])).rejects.toThrow(/discovery failed/i);
  });

  it('preserves spawn failures and other nonzero Git errors', async () => {
    const spawnFailure = createChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => spawnFailure.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })));
      return spawnFailure;
    });
    const reader = createGitIgnoreReader({ spawn, resolveGitBinaryForSpawn: () => 'git' });

    await expect(reader.getIgnoredNames('/repo', ['file'])).rejects.toThrow(/discovery failed/i);

    const otherFailure = createChild();
    const otherReader = createGitIgnoreReader({
      spawn: () => {
        queueMicrotask(() => {
          otherFailure.stderr.emit('data', 'fatal: invalid option');
          otherFailure.emit('close', 2);
        });
        return otherFailure;
      },
      resolveGitBinaryForSpawn: () => 'git',
    });
    await expect(otherReader.getIgnoredNames('/repo', ['file'])).rejects.toThrow(/invalid option/i);
  });

  it('cancels a coordinated check-ignore waiter and kills its process', async () => {
    const child = createChild();
    const controller = new AbortController();
    const reader = createGitIgnoreReader({
      spawn: () => child,
      resolveGitBinaryForSpawn: () => 'git',
      timeoutMs: 0,
      gitExecutionService: {
        withRawRead: async (_directory, task, options) => {
          return task();
        },
      },
    });

    const pending = reader.getIgnoredNames('/repo', ['file'], { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', null);
    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it('keeps filesystem search results when Gitignore admission fails', async () => {
    const runtime = createFsSearchRuntime({
      fsPromises: {
        readdir: async () => [
          { name: 'visible.ts', isDirectory: () => false, isFile: () => true },
        ],
      },
      path,
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: () => 'git',
      gitExecutionService: {
        withRawRead: async () => { throw new Error('Git execution queue wait timed out'); },
      },
    });

    await expect(runtime.searchFilesystemFiles('/repo', {
      query: 'visible',
      limit: 10,
      includeHidden: false,
      respectGitignore: true,
    })).resolves.toEqual([{
      name: 'visible.ts',
      path: path.join('/repo', 'visible.ts'),
      relativePath: 'visible.ts',
      extension: 'ts',
    }]);
  });

  it('does not turn delayed coordinated cleanup failure into unfiltered search success', async () => {
    vi.useFakeTimers();
    try {
      const cleanupBlocked = {
        code: 'ERR_PROCESS_TREE_TERMINATION',
        cleanupBlocked: true,
        descendantsTerminated: false,
      };
      const runtime = createFsSearchRuntime({
        fsPromises: {
          readdir: async () => [
            { name: 'visible.ts', isDirectory: () => false, isFile: () => true },
          ],
        },
        path,
        spawn: vi.fn(),
        resolveGitBinaryForSpawn: () => 'git',
        gitExecutionService: {
          withRawRead: (_directory, _task, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              if (options.waitForCleanup !== true) {
                reject(Object.assign(new Error('Git execution was cancelled'), { code: 'GIT_EXECUTION_CANCELLED' }));
                return;
              }
              setTimeout(() => reject(cleanupBlocked), 10);
            }, { once: true });
          }),
        },
      });
      const pending = runtime.searchFilesystemFiles('/repo', {
        query: 'visible',
        limit: 10,
        includeHidden: false,
        respectGitignore: true,
      });
      await vi.advanceTimersByTimeAsync(2_500);
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).rejects.toMatchObject(cleanupBlocked);
    } finally {
      vi.useRealTimers();
    }
  });
});
