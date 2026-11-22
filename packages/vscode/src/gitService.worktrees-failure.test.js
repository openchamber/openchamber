import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { listGitWorktrees } = await import('./gitService.ts?worktrees-failure-test');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-worktrees-failure-'));
  tempDirs.push(dir);
  return dir;
};

const makeRepo = () => {
  const dir = makeTempDir();
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  runGit(dir, ['commit', '--allow-empty', '-m', 'init']);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service listGitWorktrees failure handling (#750)', () => {
  it('returns an empty list for a directory that is not a git repository', async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();

    expect(await listGitWorktrees(dir)).toEqual([]);
  });

  it('rejects when git fails for a reason other than not-a-repository (corrupt config)', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    // A corrupt .git/config makes `git worktree list` exit 128 with
    // "fatal: bad config line ..." - a real failure that must not read
    // as a repository with no worktrees.
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'this is not valid git config [[[\n');

    await expect(listGitWorktrees(dir)).rejects.toThrow(/bad config/);
  });

  it('returns the real worktree list for a healthy repository', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    const entries = await listGitWorktrees(dir);
    expect(entries.map((entry) => fs.realpathSync(entry.path))).toEqual([fs.realpathSync(dir)]);
    expect(entries[0].branch).toBe('main');
  });
});
