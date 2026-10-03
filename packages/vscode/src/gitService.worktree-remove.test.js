import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { removeWorktree } = await import('./gitService.ts?worktree-remove-test');

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
        expect(String(warnSpy.mock.calls[0][0])).toContain(worktreePath);
        expect(warnSpy.mock.calls[0][1]).toBe('OpenCode API URL is not available');
      } finally {
        warnSpy.mockRestore();
      }
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
