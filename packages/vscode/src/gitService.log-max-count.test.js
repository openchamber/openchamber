import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getGitDiff, getGitLog, normalizeMaxCount, MAX_LOG_COUNT } = await import('./gitService.ts?log-max-count-test');

const tempDirs = [];

const runGit = (cwd, args, input) => execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// 55 commits: more than the default page of 50, so an unbounded read and a
// defaulted read are distinguishable. One fast-import writes them all; 110
// add/commit processes per repository outran the 5 s test timeout on a loaded
// machine.
const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-max-count-'));
  tempDirs.push(dir);
  runGit(dir, ['init', '-b', 'main']);
  let stream = '';
  for (let i = 1; i <= 55; i++) {
    const content = `v${i}\n`;
    const message = `c${i}`;
    stream += `commit refs/heads/main\ncommitter Test <test@example.com> ${1_700_000_000 + i} +0000\n`;
    stream += `data ${message.length}\n${message}\n`;
    stream += `M 100644 inline file.txt\ndata ${content.length}\n${content}\n`;
  }
  runGit(dir, ['fast-import', '--quiet'], stream);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service getGitLog maxCount normalization (#641)', () => {
  it('falls back to 50 for invalid maxCount instead of reading unbounded or throwing', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    for (const bad of [-5, 2.5, Number.POSITIVE_INFINITY, Number.NaN, 0, 'abc']) {
      const result = await getGitLog(dir, { maxCount: bad });
      expect(result.total).toBe(50);
      expect(result.all).toHaveLength(50);
    }
  });

  it('applies the same fallback on the --all path', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    const result = await getGitLog(dir, { maxCount: -5, all: true });
    expect(result.total).toBe(50);
    expect(result.all).toHaveLength(50);
  });

  it('clamps a huge finite maxCount to the ceiling (#1121)', async () => {
    expect(normalizeMaxCount(1_000_000_000)).toBe(MAX_LOG_COUNT);
    expect(normalizeMaxCount(MAX_LOG_COUNT + 1)).toBe(MAX_LOG_COUNT);
    expect(normalizeMaxCount(MAX_LOG_COUNT)).toBe(MAX_LOG_COUNT);
    expect(normalizeMaxCount(100)).toBe(100);
  });

  it('reads a huge finite maxCount as the bounded history on both paths (#1121)', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    const plain = await getGitLog(dir, { maxCount: 1_000_000_000 });
    expect(plain.total).toBe(55);
    expect(plain.all).toHaveLength(55);

    const allRefs = await getGitLog(dir, { maxCount: 1_000_000_000, all: true });
    expect(allRefs.total).toBe(55);
    expect(allRefs.all).toHaveLength(55);
  });

  it('passes valid maxCount through unchanged and defaults when omitted', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    const two = await getGitLog(dir, { maxCount: 2 });
    expect(two.total).toBe(2);
    expect(two.all).toHaveLength(2);

    const omitted = await getGitLog(dir, {});
    expect(omitted.total).toBe(50);

    const noOptions = await getGitLog(dir);
    expect(noOptions.total).toBe(50);
  });
});

const makeContextRepo = () => {
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

describe('VS Code git service contextLines normalization (#640)', () => {
  it('getGitDiff falls back to 3 for invalid contextLines instead of throwing', async () => {
    if (!canRunGit()) return;

    const dir = makeContextRepo();
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

    const dir = makeContextRepo();
    changeLine10(dir);

    const zero = (await getGitDiff(dir, 'file.txt', false, 0)).diff;
    expect(hunkHeader(zero)).toContain('@@ -10 +10 @@');

    const wholeFile = (await getGitDiff(dir, 'file.txt', false, 1000000)).diff;
    expect(hunkHeader(wholeFile)).toContain('@@ -1,20 +1,20 @@');
  });
});
