import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createGitIgnoreReader } from './gitignore.js';
import { createFsSearchRuntime } from './search.js';

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
});
