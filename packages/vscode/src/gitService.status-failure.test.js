import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getGitStatus } = await import('./gitService.ts?status-failure-test');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-status-failure-'));
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
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service getGitStatusRaw failure handling (#650)', () => {
  it('rejects for a directory that is not a git repository instead of reporting a clean empty status', async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();

    await expect(getGitStatus(dir)).rejects.toThrow(/not a git repository/);
  });

  it('returns the real status for a clean repository', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    const status = await getGitStatus(dir);
    expect(status.current).toBe('main');
    expect(status.files).toEqual([]);
    expect(status.isClean).toBe(true);
  });

  it('returns the real status for a dirty repository', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');

    const status = await getGitStatus(dir);
    expect(status.current).toBe('main');
    expect(status.isClean).toBe(false);
    expect(status.files.map((file) => file.path).sort()).toEqual(['file.txt', 'untracked.txt']);
  });
});
