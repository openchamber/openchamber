import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, mock } from 'bun:test';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree, getWorktreeBootstrapStatus, validateWorktreeCreate } = await import('./gitService.ts?pr-worktree-test');

const tempDirs = [];

const createTempDir = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-git-service-'));
  tempDirs.push(directory);
  return directory;
};

const runGit = (cwd, args) => execFileSync('git', args, {
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

const resolveGitExecutable = () => {
  for (const segment of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(segment, 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error('Unable to locate git executable for test wrapper');
};

const withPostPreflightFetchFailure = async (callback) => {
  const binDirectory = createTempDir();
  const wrapperPath = path.join(binDirectory, 'git');
  const markerPath = path.join(binDirectory, 'attachment-started');
  const failurePath = path.join(binDirectory, 'command-failed');
  const previousPath = process.env.PATH;
  const previousMarker = process.env.OPENCHAMBER_TEST_GIT_FAILURE_MARKER;
  const previousFailure = process.env.OPENCHAMBER_TEST_GIT_FAILURE_PATH;
  const previousRealGit = process.env.OPENCHAMBER_TEST_REAL_GIT;
  const realGit = resolveGitExecutable();

  fs.writeFileSync(wrapperPath, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const marker = process.env.OPENCHAMBER_TEST_GIT_FAILURE_MARKER;
const failure = process.env.OPENCHAMBER_TEST_GIT_FAILURE_PATH;
const realGit = process.env.OPENCHAMBER_TEST_REAL_GIT;
const failFetch = marker
  && fs.existsSync(marker)
  && args[0] === 'fetch'
  && (args[1] === 'pr-race' || args[1] === 'base');
if (failFetch) {
  if (failure && args[1] === 'base') fs.writeFileSync(failure, args.join(' '));
  process.stderr.write('simulated git command failure\\n');
  process.exit(1);
}
const result = spawnSync(realGit, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
if (
  marker
  && args[0] === 'remote'
  && (args[1] === 'add' || args[1] === 'get-url')
  && args[2] === 'pr-race'
  && result.status === 0
) {
  fs.writeFileSync(marker, 'attachment started');
}
process.exit(typeof result.status === 'number' ? result.status : 1);
`);
  fs.chmodSync(wrapperPath, 0o755);

  process.env.PATH = `${binDirectory}${path.delimiter}${previousPath || ''}`;
  process.env.OPENCHAMBER_TEST_GIT_FAILURE_MARKER = markerPath;
  process.env.OPENCHAMBER_TEST_GIT_FAILURE_PATH = failurePath;
  process.env.OPENCHAMBER_TEST_REAL_GIT = realGit;

  try {
    return await callback({ markerPath, failurePath });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousMarker === undefined) {
      delete process.env.OPENCHAMBER_TEST_GIT_FAILURE_MARKER;
    } else {
      process.env.OPENCHAMBER_TEST_GIT_FAILURE_MARKER = previousMarker;
    }
    if (previousFailure === undefined) {
      delete process.env.OPENCHAMBER_TEST_GIT_FAILURE_PATH;
    } else {
      process.env.OPENCHAMBER_TEST_GIT_FAILURE_PATH = previousFailure;
    }
    if (previousRealGit === undefined) {
      delete process.env.OPENCHAMBER_TEST_REAL_GIT;
    } else {
      process.env.OPENCHAMBER_TEST_REAL_GIT = previousRealGit;
    }
  }
};

const waitForPathExists = (target) => new Promise((resolve) => {
  if (fs.existsSync(target)) {
    resolve();
    return;
  }
  const watcher = fs.watch(path.dirname(target), () => {
    if (fs.existsSync(target)) {
      watcher.close();
      resolve();
    }
  });
});

const waitForPathAbsent = (target) => new Promise((resolve) => {
  if (!fs.existsSync(target)) {
    resolve();
    return;
  }
  const watcher = fs.watch(path.dirname(target), () => {
    if (!fs.existsSync(target)) {
      watcher.close();
      resolve();
    }
  });
});

const configureRepository = (directory) => {
  runGit(directory, ['init', '-b', 'main']);
  runGit(directory, ['config', 'user.email', 'test@example.com']);
  runGit(directory, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(directory, 'README.md'), '# Test\n');
  runGit(directory, ['add', 'README.md']);
  runGit(directory, ['commit', '-m', 'Initial commit']);
};

const getGitConfig = (directory, key) => {
  try {
    return runGit(directory, ['config', '--get', key]).trim() || null;
  } catch {
    return null;
  }
};

const withTestDataHome = async (callback) => {
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const dataHome = createTempDir();
  process.env.XDG_DATA_HOME = dataHome;

  try {
    return await callback(dataHome);
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
  }
};

const createPullRequestFixture = ({ baseRemoteName = 'base' } = {}) => {
  const repository = createTempDir();
  const baseRemote = createTempDir();
  const forkRemote = createTempDir();
  const forkClone = createTempDir();
  const prNumber = 42;

  configureRepository(repository);
  runGit(baseRemote, ['init', '--bare']);
  runGit(forkRemote, ['init', '--bare']);
  runGit(repository, ['remote', 'add', baseRemoteName, baseRemote]);
  runGit(repository, ['push', baseRemoteName, 'main']);
  runGit(baseRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  fs.rmSync(forkClone, { recursive: true, force: true });
  runGit(repository, ['clone', baseRemote, forkClone]);
  runGit(forkClone, ['config', 'user.email', 'test@example.com']);
  runGit(forkClone, ['config', 'user.name', 'Test User']);
  runGit(forkClone, ['checkout', '-b', 'feature/fork']);
  fs.writeFileSync(path.join(forkClone, 'fork.txt'), 'fork source\n');
  runGit(forkClone, ['add', 'fork.txt']);
  runGit(forkClone, ['commit', '-m', 'Fork pull request head']);
  const forkHead = runGit(forkClone, ['rev-parse', 'HEAD']).trim();
  runGit(forkClone, ['remote', 'add', 'fork', forkRemote]);
  runGit(forkClone, ['push', 'fork', 'feature/fork']);

  runGit(repository, ['checkout', '-b', 'feature/base-pr']);
  fs.writeFileSync(path.join(repository, 'base-pr.txt'), 'base pull request source\n');
  runGit(repository, ['add', 'base-pr.txt']);
  runGit(repository, ['commit', '-m', 'Base pull request head']);
  const baseHead = runGit(repository, ['rev-parse', 'HEAD']).trim();
  runGit(repository, ['push', baseRemoteName, `feature/base-pr:refs/pull/${prNumber}/head`]);
  runGit(repository, ['checkout', 'main']);

  return { repository, baseRemote, baseRemoteName, forkRemote, forkHead, baseHead, prNumber };
};

const waitForWorktreeBootstrap = async (directory) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = await getWorktreeBootstrapStatus(directory);
    if (status.status === 'ready') {
      return;
    }
    if (status.status === 'failed') {
      throw new Error(status.error || 'Worktree bootstrap failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for worktree bootstrap');
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('VS Code linked pull request worktrees', () => {
  it('provisions and checks out a reachable fork', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture();
      const created = await createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'vscode-fork-wins',
        branchName: 'pr/vscode-fork-wins',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber,
        baseRemote: 'base',
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: fixture.forkRemote,
      });

      await waitForWorktreeBootstrap(created.path);

      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.forkHead);
      expect(getGitConfig(created.path, 'branch.pr/vscode-fork-wins.remote')).toBe('pr-fork');
    });
  });

  it('uses a collision-safe fork remote without changing the base remote, then falls back through that base remote', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture({ baseRemoteName: 'pr-fork' });
      const input = {
        mode: 'existing',
        worktreeName: 'vscode-fork-remote-collision',
        branchName: 'pr/vscode-fork-remote-collision',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber,
        baseRemote: fixture.baseRemoteName,
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: fixture.forkRemote,
      };

      await expect(validateWorktreeCreate(fixture.repository, input)).resolves.toMatchObject({ ok: true });
      expect(runGit(fixture.repository, ['remote', 'get-url', fixture.baseRemoteName]).trim()).toBe(fixture.baseRemote);
      expect(() => runGit(fixture.repository, ['remote', 'get-url', 'pr-fork-pr-42'])).toThrow();

      const forkCreated = await createWorktree(fixture.repository, input);
      await waitForWorktreeBootstrap(forkCreated.path);

      expect(runGit(forkCreated.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.forkHead);
      expect(runGit(fixture.repository, ['remote', 'get-url', fixture.baseRemoteName]).trim()).toBe(fixture.baseRemote);
      expect(runGit(fixture.repository, ['remote', 'get-url', 'pr-fork-pr-42']).trim()).toBe(fixture.forkRemote);
      expect(getGitConfig(forkCreated.path, 'branch.pr/vscode-fork-remote-collision.remote')).toBe('pr-fork-pr-42');

      const unavailableFork = path.join(createTempDir(), 'missing-fork.git');
      const fallbackCreated = await createWorktree(fixture.repository, {
        ...input,
        worktreeName: 'vscode-fork-remote-collision-fallback',
        branchName: 'pr/vscode-fork-remote-collision-fallback',
        ensureRemoteUrl: unavailableFork,
      });
      await waitForWorktreeBootstrap(fallbackCreated.path);

      expect(runGit(fallbackCreated.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.baseHead);
      expect(runGit(fixture.repository, ['remote', 'get-url', fixture.baseRemoteName]).trim()).toBe(fixture.baseRemote);
      expect(getGitConfig(fallbackCreated.path, 'branch.pr/vscode-fork-remote-collision-fallback.remote')).toBeNull();
      expect(getGitConfig(fallbackCreated.path, 'branch.pr/vscode-fork-remote-collision-fallback.merge')).toBeNull();
    });
  });

  it('uses the base pull request head when the fork URL is missing', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture();
      const created = await createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'vscode-base-pr-ref',
        branchName: 'pr/vscode-base-pr-ref',
        existingBranch: 'feature/base-pr',
        prNumber: fixture.prNumber,
        baseRemote: fixture.baseRemoteName,
        setUpstream: false,
      });

      await waitForWorktreeBootstrap(created.path);

      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.baseHead);
      expect(getGitConfig(created.path, 'branch.pr/vscode-base-pr-ref.remote')).toBeNull();
      expect(getGitConfig(created.path, 'branch.pr/vscode-base-pr-ref.merge')).toBeNull();
    });
  });

  it('falls back from an unsuccessful fresh fork fetch without using a stale fork ref', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture();
      runGit(fixture.repository, ['remote', 'add', 'pr-fork', fixture.forkRemote]);
      runGit(fixture.repository, [
        'fetch',
        'pr-fork',
        '+refs/heads/feature/fork:refs/remotes/pr-fork/feature/fork',
      ]);

      const unavailableFork = path.join(createTempDir(), 'missing-fork.git');
      const created = await createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'vscode-base-fallback',
        branchName: 'pr/vscode-base-fallback',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber,
        baseRemote: 'base',
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: unavailableFork,
      });

      await waitForWorktreeBootstrap(created.path);

      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.baseHead);
      expect(getGitConfig(created.path, 'branch.pr/vscode-base-fallback.remote')).toBeNull();
      expect(getGitConfig(created.path, 'branch.pr/vscode-base-fallback.merge')).toBeNull();
    });
  });

  it('fails before fast creation when neither pull request source is accessible', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async (dataHome) => {
      const fixture = createPullRequestFixture();
      const unavailableFork = path.join(createTempDir(), 'missing-fork.git');
      const projectID = runGit(fixture.repository, ['rev-list', '--max-parents=0', '--all']).trim();
      const candidateDirectory = path.join(dataHome, 'opencode', 'worktree', projectID, 'vscode-double-source-failure');

      await expect(createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'vscode-double-source-failure',
        branchName: 'pr/vscode-double-source-failure',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber + 1,
        baseRemote: fixture.baseRemoteName,
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: unavailableFork,
        returnAfterDirectoryCreated: true,
      })).rejects.toThrow('pull_request_unavailable');

      expect(fs.existsSync(candidateDirectory)).toBe(false);
    });
  });

  it('keeps a post-preflight pull-request attachment failure structured and cleans the fast candidate', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async (dataHome) => {
      const fixture = createPullRequestFixture();
      const projectID = runGit(fixture.repository, ['rev-list', '--max-parents=0', '--all']).trim();
      const worktreeName = 'vscode-late-pr-attachment';
      const candidateDirectory = path.join(dataHome, 'opencode', 'worktree', projectID, worktreeName);
      const input = {
        mode: 'existing',
        worktreeName,
        branchName: `pr/${worktreeName}`,
        existingBranch: 'remotes/pr-race/feature/fork',
        prNumber: fixture.prNumber,
        baseRemote: 'base',
        setUpstream: true,
        upstreamRemote: 'pr-race',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-race',
        ensureRemoteUrl: fixture.forkRemote,
        returnAfterDirectoryCreated: true,
      };

      await expect(validateWorktreeCreate(fixture.repository, input)).resolves.toMatchObject({ ok: true });

      await withPostPreflightFetchFailure(async ({ markerPath, failurePath }) => {
        const failureObserved = waitForPathExists(failurePath);
        const created = await createWorktree(fixture.repository, input);
        await failureObserved;
        await waitForPathAbsent(candidateDirectory);
        const failedStatus = await getWorktreeBootstrapStatus(created.path);

        expect(fs.existsSync(markerPath)).toBe(true);
        expect(failedStatus).toMatchObject({
          status: 'failed',
          error: 'pull_request_unavailable',
          code: 'pull_request_unavailable',
        });
      });
    });
  }, 15_000);
});
