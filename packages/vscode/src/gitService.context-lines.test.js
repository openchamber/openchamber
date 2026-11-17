import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getGitDiff, getGitRangeDiff } = await import('./gitService.ts?context-lines-test');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-context-lines-'));
  tempDirs.push(dir);
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(dir, 'file.txt'), lines.join('\n') + '\n');
  runGit(dir, ['add', 'file.txt']);
  runGit(dir, ['commit', '-m', 'init']);
  return dir;
};

const changeLine10 = (dir) => {
  const lines = Array.from({ length: 20 }, (_, i) => (i === 9 ? 'line 10 CHANGED' : `line ${i + 1}`));
  fs.writeFileSync(path.join(dir, 'file.txt'), lines.join('\n') + '\n');
};

const hunkHeader = (diff) => diff.split('\n').find((line) => line.startsWith('@@'));

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service contextLines normalization (#640)', () => {
  it('getGitDiff falls back to 3 for invalid contextLines instead of throwing', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    changeLine10(dir);

    const expected = (await getGitDiff(dir, 'file.txt', false, 3)).diff;
    expect(hunkHeader(expected)).toContain('@@ -7,7 +7,7 @@');
    expect(expected).toContain('line 10 CHANGED');

    for (const bad of [2.5, Number.NaN, -5, Number.POSITIVE_INFINITY, '3', undefined]) {
      const result = await getGitDiff(dir, 'file.txt', false, bad);
      expect(result.diff).toBe(expected);
    }
  });

  it('getGitDiff passes valid contextLines through unchanged', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    changeLine10(dir);

    const zero = (await getGitDiff(dir, 'file.txt', false, 0)).diff;
    expect(hunkHeader(zero)).toContain('@@ -10 +10 @@');

    const wholeFile = (await getGitDiff(dir, 'file.txt', false, 1000000)).diff;
    expect(hunkHeader(wholeFile)).toContain('@@ -1,20 +1,20 @@');
  });

  it('getGitRangeDiff falls back to 3 for invalid contextLines instead of returning an empty diff', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    runGit(dir, ['checkout', '-b', 'feature']);
    changeLine10(dir);
    runGit(dir, ['commit', '-am', 'change']);

    const expected = (await getGitRangeDiff(dir, 'main', 'feature', 'file.txt', 3)).diff;
    expect(expected).toContain('line 10 CHANGED');
    expect(hunkHeader(expected)).toContain('@@ -7,7 +7,7 @@');

    for (const bad of [2.5, Number.NaN, -5, Number.POSITIVE_INFINITY, '3']) {
      const result = await getGitRangeDiff(dir, 'main', 'feature', 'file.txt', bad);
      expect(result.diff).toBe(expected);
    }
  });

  it('getGitRangeDiff passes valid contextLines through unchanged', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    runGit(dir, ['checkout', '-b', 'feature']);
    changeLine10(dir);
    runGit(dir, ['commit', '-am', 'change']);

    const zero = (await getGitRangeDiff(dir, 'main', 'feature', 'file.txt', 0)).diff;
    expect(hunkHeader(zero)).toContain('@@ -10 +10 @@');

    const wholeFile = (await getGitRangeDiff(dir, 'main', 'feature', 'file.txt', 1000000)).diff;
    expect(hunkHeader(wholeFile)).toContain('@@ -1,20 +1,20 @@');
  });
});
