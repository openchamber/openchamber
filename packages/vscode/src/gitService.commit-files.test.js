import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getCommitFiles } = await import('./gitService.ts?commit-files-test');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-commit-files-'));
  tempDirs.push(dir);
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'line 1\nline 2\n');
  runGit(dir, ['add', 'file.txt']);
  runGit(dir, ['commit', '-m', 'root']);
  const root = runGit(dir, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(dir, 'file.txt'), 'line 1 changed\nline 2\n');
  runGit(dir, ['add', 'file.txt']);
  runGit(dir, ['commit', '-m', 'second']);
  const second = runGit(dir, ['rev-parse', 'HEAD']).trim();
  runGit(dir, ['commit', '--allow-empty', '-m', 'empty']);
  const empty = runGit(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, root, second, empty };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service getCommitFiles bad hash (#645)', () => {
  it('throws for a bad or nonsense hash instead of returning an empty list', async () => {
    if (!canRunGit()) return;

    const { dir } = makeRepo();

    await expect(getCommitFiles(dir, 'deadbeefdeadbeef')).rejects.toThrow();
    await expect(getCommitFiles(dir, 'no-such-commit')).rejects.toThrow();
  });

  it('throws for an empty hash', async () => {
    if (!canRunGit()) return;

    const { dir } = makeRepo();

    await expect(getCommitFiles(dir, '')).rejects.toThrow('A commit hash is required');
    await expect(getCommitFiles(dir, '   ')).rejects.toThrow('A commit hash is required');
  });

  it('returns the changed files for valid, root, and empty commits unchanged', async () => {
    if (!canRunGit()) return;

    const { dir, root, second, empty } = makeRepo();

    const secondFiles = await getCommitFiles(dir, second);
    expect(secondFiles.files).toHaveLength(1);
    expect(secondFiles.files[0].path).toBe('file.txt');
    expect(secondFiles.files[0].changeType).toBe('M');

    const rootFiles = await getCommitFiles(dir, root);
    expect(rootFiles.files).toHaveLength(1);
    expect(rootFiles.files[0].path).toBe('file.txt');
    expect(rootFiles.files[0].changeType).toBe('A');

    const emptyFiles = await getCommitFiles(dir, empty);
    expect(emptyFiles).toEqual({ files: [] });
  });
});
