import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getGitRangeDiff, getGitRangeFiles } = await import('./gitService.ts?range-refs-test');

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

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-range-refs-'));
  tempDirs.push(dir);
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'line 1\nline 2\n');
  runGit(dir, ['add', 'file.txt']);
  runGit(dir, ['commit', '-m', 'init']);
  runGit(dir, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'line 1 CHANGED\nline 2\n');
  runGit(dir, ['commit', '-am', 'change']);
  runGit(dir, ['checkout', 'main']);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service range refs (#644)', () => {
  it('returns the diff and files for a good range', async () => {
    if (!canRunGit()) return;
    const dir = makeRepo();
    const diff = await getGitRangeDiff(dir, 'main', 'feature', 'file.txt', 3);
    expect(diff.diff).toContain('line 1 CHANGED');
    await expect(getGitRangeFiles(dir, 'main', 'feature')).resolves.toEqual(['file.txt']);
  });

  it('still returns empty results for a legitimately empty range', async () => {
    if (!canRunGit()) return;
    const dir = makeRepo();
    await expect(getGitRangeDiff(dir, 'main', 'main', 'file.txt', 3)).resolves.toEqual({ diff: '' });
    await expect(getGitRangeFiles(dir, 'main', 'main')).resolves.toEqual([]);
  });

  it('rejects a bad base for both range functions', async () => {
    if (!canRunGit()) return;
    const dir = makeRepo();
    await expect(getGitRangeDiff(dir, 'no-such-branch', 'feature', 'file.txt', 3)).rejects.toThrow();
    await expect(getGitRangeFiles(dir, 'no-such-branch', 'feature')).rejects.toThrow();
  });

  it('rejects a bad head for both range functions', async () => {
    if (!canRunGit()) return;
    const dir = makeRepo();
    await expect(getGitRangeDiff(dir, 'main', 'no-such-head', 'file.txt', 3)).rejects.toThrow();
    await expect(getGitRangeFiles(dir, 'main', 'no-such-head')).rejects.toThrow();
  });

  it('rejects empty base/head for both range functions', async () => {
    if (!canRunGit()) return;
    const dir = makeRepo();
    await expect(getGitRangeDiff(dir, '', 'feature', 'file.txt', 3)).rejects.toThrow('base and head are required');
    await expect(getGitRangeDiff(dir, 'main', '', 'file.txt', 3)).rejects.toThrow('base and head are required');
    await expect(getGitRangeFiles(dir, '', 'feature')).rejects.toThrow('base and head are required');
    await expect(getGitRangeFiles(dir, 'main', '')).rejects.toThrow('base and head are required');
  });
});
