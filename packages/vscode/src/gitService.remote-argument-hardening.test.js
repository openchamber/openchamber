import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { createWorktree, getWorktreeBootstrapStatus, gitFetch, gitPull, removeRemote, validateWorktreeCreate } = await import('./gitService.ts?remote-argument-hardening-test');

const OPTION_LIKE_REMOTE = '--mirror';

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
  runGit(repository, ['init', '-b', 'main']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'init']);
  runGit(repository, ['remote', 'add', 'origin', remote]);
  runGit(repository, ['push', 'origin', 'HEAD:main']);
  runGit(repository, ['fetch', 'origin']);
  return { remote, repository };
};

const addOptionLikeRemote = (repository, remoteUrl, { fetch = true } = {}) => {
  runGit(repository, ['remote', 'add', '--', OPTION_LIKE_REMOTE, remoteUrl]);
  if (fetch) {
    runGit(repository, ['fetch', '--', OPTION_LIKE_REMOTE]);
  }
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

const waitForBootstrapReady = async (directory) => {
  const deadline = Date.now() + 10_000;
  let status = await getWorktreeBootstrapStatus(directory);
  while (status.status === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await getWorktreeBootstrapStatus(directory);
  }
  expect(status.status).toBe('ready');
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git remote arguments with option-like names', () => {
  it('creates and reads a remote whose name looks like a git option during worktree creation', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/option-like-remote',
        worktreeName: 'option-like-remote',
        ensureRemoteName: OPTION_LIKE_REMOTE,
        ensureRemoteUrl: remote,
      });

      expect(created.branch).toBe('openchamber/option-like-remote');
      expect(runGit(repository, ['remote', 'get-url', '--', OPTION_LIKE_REMOTE]).trim()).toBe(remote);
      await waitForBootstrapReady(created.path);
    });
  }, 30_000);

  it('updates the URL of an existing option-like remote during worktree creation', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();
      const otherRemote = createTempDir();
      runGit(otherRemote, ['init', '--bare', '--initial-branch=main']);
      runGit(repository, ['remote', 'add', '--', OPTION_LIKE_REMOTE, otherRemote]);

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/option-like-remote-update',
        worktreeName: 'option-like-remote-update',
        ensureRemoteName: OPTION_LIKE_REMOTE,
        ensureRemoteUrl: remote,
      });

      expect(created.branch).toBe('openchamber/option-like-remote-update');
      expect(runGit(repository, ['remote', 'get-url', '--', OPTION_LIKE_REMOTE]).trim()).toBe(remote);
      await waitForBootstrapReady(created.path);
    });
  }, 30_000);

  it('fetches from an option-like remote through the raw fallback', async () => {
    if (!canRunGit()) return;

    const { remote, repository } = createRepositoryWithRemote();
    addOptionLikeRemote(repository, remote, { fetch: false });

    const result = await gitFetch(repository, { remote: OPTION_LIKE_REMOTE });

    expect(result.success).toBe(true);
    const expected = runGit(remote, ['rev-parse', 'main']).trim();
    expect(runGit(repository, ['rev-parse', `refs/remotes/${OPTION_LIKE_REMOTE}/main`]).trim()).toBe(expected);
  }, 30_000);

  it('pulls from a normal remote through the raw fallback', async () => {
    if (!canRunGit()) return;

    const { remote, repository } = createRepositoryWithRemote();
    const scratch = createTempDir();
    runGit(scratch, ['clone', '--quiet', remote, '.']);
    runGit(scratch, ['config', 'user.email', 'test@example.com']);
    runGit(scratch, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(scratch, 'NEXT.md'), '# next\n');
    runGit(scratch, ['add', 'NEXT.md']);
    runGit(scratch, ['commit', '-m', 'next']);
    const remoteHead = runGit(scratch, ['rev-parse', 'HEAD']).trim();
    runGit(scratch, ['push', 'origin', 'HEAD:main']);

    const result = await gitPull(repository, {
      remote: 'origin',
      branch: 'main',
      rebase: true,
    });

    expect(result.success).toBe(true);
    expect(runGit(repository, ['rev-parse', 'HEAD']).trim()).toBe(remoteHead);
  }, 30_000);

  it('validates a start ref and upstream on an option-like remote', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();
      fs.writeFileSync(path.join(repository, 'OPTION.md'), '# option\n');
      runGit(repository, ['add', 'OPTION.md']);
      runGit(repository, ['commit', '-m', 'option-like branch']);
      runGit(repository, ['push', '--', remote, 'HEAD:refs/heads/feature/option-like']);
      addOptionLikeRemote(repository, remote);

      const validation = await validateWorktreeCreate(repository, {
        mode: 'new',
        branchName: 'feature/option-like-worktree',
        worktreeName: 'option-like-worktree',
        startRef: `remotes/${OPTION_LIKE_REMOTE}/feature/option-like`,
        setUpstream: true,
        upstreamRemote: OPTION_LIKE_REMOTE,
        upstreamBranch: 'feature/option-like',
      });

      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
    });
  }, 30_000);

  it('creates a worktree from an option-like remote start ref', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();
      fs.writeFileSync(path.join(repository, 'OPTION.md'), '# option\n');
      runGit(repository, ['add', 'OPTION.md']);
      runGit(repository, ['commit', '-m', 'option-like start ref']);
      const sha = runGit(repository, ['rev-parse', 'HEAD']).trim();
      runGit(repository, ['push', '--', remote, 'HEAD:refs/heads/feature/option-like']);
      addOptionLikeRemote(repository, remote, { fetch: false });

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/option-like-start-ref',
        worktreeName: 'option-like-start-ref',
        startRef: `remotes/${OPTION_LIKE_REMOTE}/feature/option-like`,
      });

      expect(created.branch).toBe('openchamber/option-like-start-ref');
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(sha);
      await waitForBootstrapReady(created.path);
    });
  }, 30_000);

  it('does not interpret an option-like ensureRemoteUrl as a git option when validating', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const markerPath = path.join(createTempDir(), 'upload-pack-ran.marker');
      const scriptPath = path.join(createTempDir(), 'upload-pack-probe.sh');
      fs.writeFileSync(scriptPath, `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\nexit 1\n`);
      fs.chmodSync(scriptPath, 0o755);

      const validation = await validateWorktreeCreate(repository, {
        mode: 'existing',
        branchName: 'feature/login-wt',
        worktreeName: 'feature-login-wt',
        existingBranch: 'remotes/pr-alice/feature/login',
        ensureRemoteName: 'pr-alice',
        ensureRemoteUrl: `--upload-pack=${scriptPath}`,
      });

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(validation.ok).toBe(false);
    });
  }, 30_000);

  it('removes a remote whose name looks like a git option', async () => {
    if (!canRunGit()) return;

    const { remote, repository } = createRepositoryWithRemote();
    runGit(repository, ['remote', 'add', '--', OPTION_LIKE_REMOTE, remote]);
    expect(runGit(repository, ['remote']).split('\n').map((line) => line.trim())).toContain(OPTION_LIKE_REMOTE);

    const result = await removeRemote(repository, OPTION_LIKE_REMOTE);

    expect(result.success).toBe(true);
    expect(runGit(repository, ['remote']).split('\n').map((line) => line.trim())).not.toContain(OPTION_LIKE_REMOTE);
  }, 30_000);
});
