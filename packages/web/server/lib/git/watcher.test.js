import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { createGitChangeWatcher } from './watcher.js';

const makeRepoDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'git-watch-'));
  mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
};

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('createGitChangeWatcher', () => {
  test('broadcasts the requested directory after .git changes settle', async () => {
    const dir = makeRepoDir();
    const broadcast = vi.fn();
    const watcher = createGitChangeWatcher({ broadcast, debounceMs: 100 });
    watcher.ensureWatch(dir);
    await new Promise((resolve) => setTimeout(resolve, 50));

    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    await waitFor(() => broadcast.mock.calls.length >= 1);
    expect(broadcast.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(broadcast.mock.calls.every(([value]) => value === dir)).toBe(true);
    watcher.dispose();
  });

  test('ignores .lock files', async () => {
    const dir = makeRepoDir();
    const broadcast = vi.fn();
    const watcherRecords = [];
    const watchMock = vi.fn((target, _options, handler) => {
      const watcher = new EventEmitter();
      watcher.close = vi.fn();
      watcherRecords.push({ target, listener: handler, watcher });
      return watcher;
    });

    const watcher = createGitChangeWatcher({
      broadcast,
      debounceMs: 100,
      watchImpl: watchMock,
    });
    watcher.ensureWatch(dir);

    const rootWatcher = watcherRecords.find((record) => record.target === path.join(dir, '.git'));
    expect(rootWatcher).toBeTruthy();
    rootWatcher.listener('rename', 'index.lock');

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(broadcast).not.toHaveBeenCalled();

    watcher.dispose();
  });

  test('resolves linked-worktree .git files', async () => {
    const main = makeRepoDir();
    const linked = mkdtempSync(path.join(tmpdir(), 'git-watch-linked-'));
    const gitdir = path.join(main, '.git', 'worktrees', 'wt');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(linked, '.git'), `gitdir: ${gitdir}\n`);

    const broadcast = vi.fn();
    const watcher = createGitChangeWatcher({ broadcast, debounceMs: 100 });
    watcher.ensureWatch(linked);
    await new Promise((resolve) => setTimeout(resolve, 50));

    writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/other\n');
    await waitFor(() => broadcast.mock.calls.length >= 1);
    expect(broadcast).toHaveBeenCalledWith(linked);
    watcher.dispose();
  });

  test('does nothing for a directory without .git', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'git-watch-plain-'));
    const broadcast = vi.fn();
    const watcher = createGitChangeWatcher({ broadcast, debounceMs: 50 });

    expect(() => watcher.ensureWatch(dir)).not.toThrow();
    watcher.dispose();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
