import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { resetToCommit } = await import('./gitService.ts?reset-guard-test');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-reset-guard-'));
  tempDirs.push(dir);
  return dir;
};

// A repository with two commits; returns the directory and both hashes.
const makeRepo = () => {
  const dir = makeTempDir();
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  runGit(dir, ['add', 'file.txt']);
  runGit(dir, ['commit', '-m', 'one']);
  const first = runGit(dir, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(dir, 'file.txt'), 'two\n');
  runGit(dir, ['add', 'file.txt']);
  runGit(dir, ['commit', '-m', 'two']);
  const second = runGit(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, first, second };
};

const headOf = (dir) => runGit(dir, ['rev-parse', 'HEAD']).trim();

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service resetToCommit hard-reset guard (#663)', () => {
  it('rejects and does not move HEAD when the pre-reset status read fails', async () => {
    if (!canRunGit()) return;

    const { dir, first, second } = makeRepo();
    const configPath = path.join(dir, '.git', 'config');
    const config = fs.readFileSync(configPath, 'utf8');
    // A corrupt config makes `git status --porcelain` fail with a
    // bad-config error: the guard must fail closed, not read the empty
    // stdout as a clean tree and run the hard reset.
    fs.writeFileSync(configPath, 'garbage [[[\n');
    try {
      await expect(resetToCommit(dir, first, 'hard')).rejects.toThrow(/bad config/i);
    } finally {
      fs.writeFileSync(configPath, config);
    }
    expect(headOf(dir)).toBe(second);
    expect(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8')).toBe('two\n');
  });

  it('rejects for a directory that is not a git repository', async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();

    await expect(resetToCommit(dir, '1234567', 'hard')).rejects.toThrow(/not a git repository/i);
  });

  it('hard-resets a clean tree without force', async () => {
    if (!canRunGit()) return;

    const { dir, first } = makeRepo();

    await expect(resetToCommit(dir, first, 'hard')).resolves.toEqual({ success: true });
    expect(headOf(dir)).toBe(first);
  });

  it('refuses a dirty tree without force and leaves HEAD and the change in place', async () => {
    if (!canRunGit()) return;

    const { dir, first, second } = makeRepo();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'dirty\n');

    await expect(resetToCommit(dir, first, 'hard')).rejects.toThrow(/Cannot hard reset/);
    expect(headOf(dir)).toBe(second);
    expect(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8')).toBe('dirty\n');
  });

  it('force still skips the guard and hard-resets a dirty tree', async () => {
    if (!canRunGit()) return;

    const { dir, first } = makeRepo();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'dirty\n');

    await expect(resetToCommit(dir, first, 'hard', true)).resolves.toEqual({ success: true });
    expect(headOf(dir)).toBe(first);
    expect(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8')).toBe('one\n');
  });
});
