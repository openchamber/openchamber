import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getRemotes } = await import('./gitService.ts?remotes-failure-test');

const tempDirs = [];

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-remotes-failure-'));
  tempDirs.push(dir);
  return dir;
};

const makeRepo = () => {
  const dir = makeTempDir();
  runGit(dir, ['init', '-b', 'main']);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service getRemotes failure handling (#662)', () => {
  it('returns the remotes of a real repository', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    runGit(dir, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    runGit(dir, ['remote', 'set-url', '--push', 'origin', 'git@github.com:owner/push.git']);

    await expect(getRemotes(dir)).resolves.toEqual([
      { name: 'origin', fetchUrl: 'git@github.com:owner/repo.git', pushUrl: 'git@github.com:owner/push.git' },
    ]);
  });

  it('returns [] for a repository with no remotes', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    await expect(getRemotes(dir)).resolves.toEqual([]);
  });

  it('returns [] for a directory that is not a git repository', async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();

    await expect(getRemotes(dir)).resolves.toEqual([]);
  });

  it('rejects when the remote read fails for a reason other than not-a-repository', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    runGit(dir, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    // A corrupt config makes `git remote -v` fail with a bad-config error,
    // not a not-a-repository error: the failure must surface with git's
    // error instead of reading as a repository with no remotes.
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'garbage [[[\n');

    await expect(getRemotes(dir)).rejects.toThrow(/bad config/i);
  });
});
