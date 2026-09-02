import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree } = await import('./gitService.ts?worktree-fetch-fallback-test');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-git-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const createRepositoryWithRemote = () => {
  const remote = createTempDir();
  const repository = createTempDir();
  runGit(remote, ['init', '--bare', '--initial-branch=main']);
  runGit(repository, ['init', '-b', 'next']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'init']);
  runGit(repository, ['remote', 'add', 'origin', remote]);
  runGit(repository, ['push', 'origin', 'HEAD:main']);
  runGit(repository, ['fetch', 'origin']);
  return { repository };
};

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code worktree create from a remote start ref', () => {
  it('falls back to the tracked local branch when the source fetch fails', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const { repository } = createRepositoryWithRemote();
      runGit(repository, ['branch', '--set-upstream-to=origin/main', 'next']);
      runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/stale-ref-wt',
        worktreeName: 'stale-ref-wt',
        startRef: 'remotes/origin/main',
      });

      expect(created.branch).toBe('openchamber/stale-ref-wt');
      expect(created.sourceFetchFailed).toBe(true);
      const expectedHead = runGit(repository, ['rev-parse', 'next']).trim();
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(expectedHead);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);

  it('rejects creation when the remote start ref was never fetched and cannot be fetched', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const { repository } = createRepositoryWithRemote();
      runGit(repository, ['update-ref', '-d', 'refs/remotes/origin/main']);
      runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);

      await expect(createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/never-fetched-wt',
        worktreeName: 'never-fetched-wt',
        startRef: 'remotes/origin/main',
      })).rejects.toThrow(/does not appear to be a git repository|Could not read from remote repository/i);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);
});
