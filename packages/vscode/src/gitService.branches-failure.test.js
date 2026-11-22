import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getGitBranches, getGitUnpushedBranchCounts } = await import('./gitService.ts?branches-failure-test');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-branches-failure-'));
  tempDirs.push(dir);
  return dir;
};

const makeRepo = () => {
  const dir = makeTempDir();
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n');
  runGit(dir, ['add', 'file.txt']);
  runGit(dir, ['commit', '-m', 'init']);
  runGit(dir, ['branch', 'feature']);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service getGitBranchesRaw failure handling (#661)', () => {
  it('rejects for a directory that is not a git repository instead of reporting an empty branch list', async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();

    await expect(getGitBranches(dir)).rejects.toThrow(/not a git repository/);
  });

  it('rejects unpushed branch counts for a directory that is not a git repository', async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();

    await expect(getGitUnpushedBranchCounts(dir, ['main'])).rejects.toThrow(/not a git repository/);
  });

  it('returns the real branch list for a repository', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    const result = await getGitBranches(dir);
    expect(result.current).toBe('main');
    expect(result.all.sort()).toEqual(['feature', 'main']);
    expect(result.branches.main.current).toBe(true);
    expect(result.branches.feature.current).toBe(false);
  });
});
