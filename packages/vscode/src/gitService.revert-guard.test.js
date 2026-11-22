import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { revertGitFile } = await import('./gitService.ts?revert-guard-test');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-revert-guard-'));
  tempDirs.push(dir);
  return dir;
};

// A repository with one committed file; returns the directory.
const makeRepo = () => {
  const dir = makeTempDir();
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');
  runGit(dir, ['add', 'tracked.txt']);
  runGit(dir, ['commit', '-m', 'init']);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service revertGitFile deletion guard (#734)', () => {
  it('rejects and deletes nothing for a file in a directory that is not a repository', async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'precious.txt'), 'important data\n');

    await expect(revertGitFile(dir, 'precious.txt')).rejects.toThrow(/not a git repository/i);
    expect(fs.readFileSync(path.join(dir, 'precious.txt'), 'utf8')).toBe('important data\n');
  });

  it("rejects and deletes nothing for '.' outside a repository", async () => {
    if (!canRunGit()) return;

    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'marker\n');

    await expect(revertGitFile(dir, '.')).rejects.toThrow();
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8')).toBe('marker\n');
  });

  it("rejects and deletes nothing for '.' at the repository root", async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'scratch\n');

    await expect(revertGitFile(dir, '.')).rejects.toThrow(/repository root/i);
    expect(fs.existsSync(path.join(dir, 'tracked.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'untracked.txt'))).toBe(true);
  });

  it('rejects a path that resolves outside the repository and leaves it intact', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    const outside = makeTempDir();
    const outsideFile = path.join(outside, 'outside.txt');
    fs.writeFileSync(outsideFile, 'outside\n');

    await expect(revertGitFile(dir, path.relative(dir, outsideFile))).rejects.toThrow(/outside repository/i);
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside\n');
  });

  it('rejects a path git cannot confirm as tracked or untracked and deletes nothing', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    await expect(revertGitFile(dir, 'missing.txt')).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'tracked.txt'))).toBe(true);
  });

  it('deletes an affirmatively untracked file inside a repository', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'scratch\n');

    await expect(revertGitFile(dir, 'untracked.txt')).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'untracked.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'tracked.txt'))).toBe(true);
  });

  it('reverts a modified tracked symlink that points outside the repository', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    const outside = makeTempDir();
    const firstTarget = path.join(outside, 'first.txt');
    const secondTarget = path.join(outside, 'second.txt');
    fs.writeFileSync(firstTarget, 'first\n');
    fs.writeFileSync(secondTarget, 'second\n');
    fs.symlinkSync(firstTarget, path.join(dir, 'link.txt'));
    runGit(dir, ['add', 'link.txt']);
    runGit(dir, ['commit', '-m', 'add outward symlink']);

    // The working-tree modification is the re-pointed link itself.
    fs.unlinkSync(path.join(dir, 'link.txt'));
    fs.symlinkSync(secondTarget, path.join(dir, 'link.txt'));

    await expect(revertGitFile(dir, 'link.txt')).resolves.toBeUndefined();
    expect(fs.readlinkSync(path.join(dir, 'link.txt'))).toBe(firstTarget);
    expect(fs.readFileSync(firstTarget, 'utf8')).toBe('first\n');
    expect(fs.readFileSync(secondTarget, 'utf8')).toBe('second\n');
  });

  it('restores a tracked file with working-tree changes', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'modified\n');

    await expect(revertGitFile(dir, 'tracked.txt')).resolves.toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf8')).toBe('base\n');
  });
});
