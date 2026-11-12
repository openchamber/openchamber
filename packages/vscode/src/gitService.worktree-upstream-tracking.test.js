import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree, getWorktreeBootstrapStatus } = await import('./gitService.ts?worktree-upstream-tracking-test');

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

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

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

const readBranchConfig = (cwd, branch, key) => {
  try {
    return runGit(cwd, ['config', '--get', `branch.${branch}.${key}`]).trim();
  } catch {
    return '';
  }
};

const waitForBootstrapReady = async (directory) => {
  const deadline = Date.now() + 10_000;
  let status = await getWorktreeBootstrapStatus(directory);
  while (status.status === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await getWorktreeBootstrapStatus(directory);
  }
  expect(status.status).toBe('ready');
};

const withDataHome = async (test) => {
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = createTempDir();
  try {
    await test();
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

describe('VS Code worktree upstream tracking', () => {
  it('leaves branch tracking unset when the upstream ref cannot be fetched', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      runGit(repository, ['branch', 'feature/tracking']);
      const emptyRemote = createTempDir();
      runGit(emptyRemote, ['init', '--bare']);
      runGit(repository, ['remote', 'add', 'broken-upstream', emptyRemote]);

      const created = await createWorktree(repository, {
        mode: 'existing',
        branchName: 'feature/tracking-wt',
        worktreeName: 'feature-tracking-wt',
        existingBranch: 'feature/tracking',
        setUpstream: true,
        upstreamRemote: 'broken-upstream',
        upstreamBranch: 'does-not-exist',
      });

      expect(created.branch).toBe('feature/tracking');
      const expectedHead = runGit(repository, ['rev-parse', 'feature/tracking']).trim();
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(expectedHead);

      await waitForBootstrapReady(created.path);

      expect(readBranchConfig(created.path, 'feature/tracking', 'remote')).toBe('');
      expect(readBranchConfig(created.path, 'feature/tracking', 'merge')).toBe('');
    });
  }, 30_000);

  it('sets branch tracking when the upstream ref can be fetched', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      runGit(repository, ['branch', 'feature/tracking']);

      const created = await createWorktree(repository, {
        mode: 'existing',
        branchName: 'feature/tracking-wt',
        worktreeName: 'feature-tracking-wt',
        existingBranch: 'feature/tracking',
        setUpstream: true,
        upstreamRemote: 'origin',
        upstreamBranch: 'main',
      });

      await waitForBootstrapReady(created.path);

      expect(readBranchConfig(created.path, 'feature/tracking', 'remote')).toBe('origin');
      expect(readBranchConfig(created.path, 'feature/tracking', 'merge')).toBe('refs/heads/main');
    });
  }, 30_000);
});
