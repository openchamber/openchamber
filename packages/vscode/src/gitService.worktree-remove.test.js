import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree, getWorktreeBootstrapStatus, removeWorktree, waitForWorktreeRemoval } = await import('./gitService.ts?worktree-remove-test');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-worktree-remove-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const createRepositoryWithWorktree = () => {
  const repo = createTempDir();
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test']);
  runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
  const worktreePath = path.join(createTempDir(), 'feature');
  runGit(repo, ['worktree', 'add', worktreePath, '-b', 'feature']);
  return { repo, worktreePath };
};

const withIsolatedOpenCodeData = async (run) => {
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = createTempDir();
  try {
    await run();
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code worktree removal instance disposal', () => {
  it('disposes the registered worktree instance before git removes the directory', async () => {
    if (!canRunGit()) return;

    await withIsolatedOpenCodeData(async () => {
      const { repo, worktreePath } = createRepositoryWithWorktree();
      const targetRealPath = fs.realpathSync(worktreePath);

      let observed = null;
      const disposeInstance = mock(async (directory) => {
        observed = {
          realPath: fs.realpathSync(directory),
          directoryExists: fs.existsSync(directory),
        };
      });

      await expect(removeWorktree(repo, {
        directory: worktreePath,
        disposeInstance,
      })).resolves.toBe(true);

      expect(disposeInstance).toHaveBeenCalledTimes(1);
      expect(observed).toEqual({ realPath: targetRealPath, directoryExists: true });
      expect(fs.existsSync(worktreePath)).toBe(false);
    });
  });

  it('holds requests for the worktree folders from the release until the removal settles', async () => {
    if (!canRunGit()) return;

    await withIsolatedOpenCodeData(async () => {
      const { repo, worktreePath } = createRepositoryWithWorktree();
      const settledAfter = (promise) => promise.then(() => 'settled');
      const pendingAfter = (ms) => new Promise((resolve) => setTimeout(() => resolve('pending'), ms));
      let insideHold = null;
      const observed = {};
      const disposeInstance = mock(async () => {
        insideHold = waitForWorktreeRemoval(path.join(worktreePath, 'sub'));
        observed.inside = await Promise.race([settledAfter(insideHold), pendingAfter(50)]);
        observed.project = await Promise.race([settledAfter(waitForWorktreeRemoval(repo)), pendingAfter(50)]);
      });

      await expect(removeWorktree(repo, { directory: worktreePath, disposeInstance })).resolves.toBe(true);

      expect(observed).toEqual({ inside: 'pending', project: 'settled' });
      await expect(insideHold).resolves.toBeUndefined();
    });
  });

  // Windows reports a folder held by another process as "Permission denied";
  // a read-only directory gives git the same failure on macOS and Linux.
  it('releases the worktree instance again before retrying a busy removal', async () => {
    if (!canRunGit() || process.platform === 'win32' || process.getuid?.() === 0) return;

    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    await withIsolatedOpenCodeData(async () => {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
      // Created the way the app does, inside the data-dir worktree root.
      const { path: worktreePath } = await createWorktree(repo, { mode: 'new', branchName: 'busy-release', worktreeName: 'busy-release' });
      // Its background checkout must finish before the platform is faked below.
      const deadline = Date.now() + 10_000;
      while ((await getWorktreeBootstrapStatus(worktreePath)).status === 'pending' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const held = path.join(worktreePath, 'held');
      fs.mkdirSync(held);
      fs.writeFileSync(path.join(held, 'file.txt'), 'held');
      fs.chmodSync(held, 0o555);

      // The second release is the one that frees the folder.
      const disposeInstance = mock(async () => {
        if (disposeInstance.mock.calls.length === 2) fs.chmodSync(held, 0o755);
      });
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        await expect(removeWorktree(repo, { directory: worktreePath, disposeInstance })).resolves.toBe(true);
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }

      expect(disposeInstance).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(worktreePath)).toBe(false);
    });
  }, 30_000);

  it('warns about a failed instance disposal and still removes the worktree', async () => {
    if (!canRunGit()) return;

    await withIsolatedOpenCodeData(async () => {
      const { repo, worktreePath } = createRepositoryWithWorktree();
      const disposeInstance = mock(async () => {
        throw new Error('OpenCode API URL is not available');
      });
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await expect(removeWorktree(repo, {
          directory: worktreePath,
          disposeInstance,
        })).resolves.toBe(true);

        expect(disposeInstance).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(worktreePath)).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        // The warn message carries the path git reported in `worktree list
        // --porcelain`, which uses forward slashes on Windows while
        // `worktreePath` is built with `path.join` (backslashes there). Compare
        // separator-insensitively so the assertion holds on both platforms.
        const warnMessage = String(warnSpy.mock.calls[0][0]).replaceAll('\\', '/');
        expect(warnMessage).toContain(worktreePath.replaceAll('\\', '/'));
        expect(warnSpy.mock.calls[0][1]).toBe('OpenCode API URL is not available');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('keeps a branch another checkout holds and still removes the worktree', async () => {
    if (!canRunGit()) return;

    await withIsolatedOpenCodeData(async () => {
      const { repo, worktreePath } = createRepositoryWithWorktree();
      runGit(worktreePath, ['checkout', '--ignore-other-worktrees', 'main']);

      await expect(removeWorktree(repo, { directory: worktreePath, deleteLocalBranch: true })).resolves.toBe(true);

      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(runGit(repo, ['branch', '--list', 'main']).trim()).toContain('main');
    });
  });

  it('keeps the branch a remote names as its default', async () => {
    if (!canRunGit()) return;

    await withIsolatedOpenCodeData(async () => {
      const { repo, worktreePath } = createRepositoryWithWorktree();
      runGit(repo, ['update-ref', 'refs/remotes/origin/feature', 'feature']);
      runGit(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature']);

      await expect(removeWorktree(repo, { directory: worktreePath, deleteLocalBranch: true })).resolves.toBe(true);

      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(runGit(repo, ['branch', '--list', 'feature']).trim()).toContain('feature');
    });
  });

  it('never disposes the primary workspace', async () => {
    if (!canRunGit()) return;

    await withIsolatedOpenCodeData(async () => {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);

      const disposeInstance = mock(async () => {});
      await expect(removeWorktree(repo, {
        directory: repo,
        disposeInstance,
      })).rejects.toThrow('Cannot remove the primary workspace');
      expect(disposeInstance).not.toHaveBeenCalled();
    });
  });

  it('does not dispose for a path that is not a registered linked worktree', async () => {
    if (!canRunGit()) return;

    await withIsolatedOpenCodeData(async () => {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
      const unregistered = createTempDir();

      const disposeInstance = mock(async () => {});
      await expect(removeWorktree(repo, {
        directory: unregistered,
        disposeInstance,
      })).resolves.toBe(true);
      expect(disposeInstance).not.toHaveBeenCalled();
    });
  });
});
