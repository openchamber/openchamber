import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getGitStatus } = await import('./gitService.ts?worktree-inprogress-test');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-inprogress-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args, allowFail = false) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (!allowFail) throw error;
    return String(error.stdout || '');
  }
};

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const initRepo = (dir) => {
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'init']);
};

const makeConflictedMerge = (dir, base) => {
  runGit(dir, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'feature\n');
  runGit(dir, ['commit', '-am', 'feature']);
  runGit(dir, ['checkout', base]);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'main\n');
  runGit(dir, ['commit', '-am', 'main change']);
  runGit(dir, ['merge', 'feature'], true);
};

const addLinkedWorktree = (baseDir) => {
  const parent = createTempDir();
  const wtDir = path.join(parent, 'linked');
  runGit(baseDir, ['worktree', 'add', '-b', 'wtbranch', wtDir, 'main']);
  runGit(wtDir, ['config', 'user.email', 'test@example.com']);
  runGit(wtDir, ['config', 'user.name', 'Test']);
  return wtDir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service getGitStatus in-progress operations in linked worktrees (#648)', () => {
  it('reports mergeInProgress in the main worktree (control)', async () => {
    if (!canRunGit()) return;
    const dir = createTempDir();
    initRepo(dir);
    makeConflictedMerge(dir, 'main');

    const status = await getGitStatus(dir);
    expect(status.mergeInProgress).toBeTruthy();
    expect(status.mergeInProgress.head).toHaveLength(7);
    expect(status.mergeInProgress.message).toContain('feature');
  });

  it('reports mergeInProgress in a linked worktree', async () => {
    if (!canRunGit()) return;
    const baseDir = createTempDir();
    initRepo(baseDir);
    const wtDir = addLinkedWorktree(baseDir);
    makeConflictedMerge(wtDir, 'wtbranch');

    // The naive path really is broken here: .git is a file in a linked worktree.
    expect(fs.statSync(path.join(wtDir, '.git')).isFile()).toBe(true);

    const status = await getGitStatus(wtDir);
    expect(status.mergeInProgress).toBeTruthy();
    expect(status.mergeInProgress.head).toHaveLength(7);
    expect(status.mergeInProgress.message).toContain('feature');
  });

  it('reports rebaseInProgress in a linked worktree', async () => {
    if (!canRunGit()) return;
    const baseDir = createTempDir();
    initRepo(baseDir);
    const wtDir = addLinkedWorktree(baseDir);

    runGit(wtDir, ['checkout', '-b', 'topic']);
    fs.writeFileSync(path.join(wtDir, 'file.txt'), 'topic\n');
    runGit(wtDir, ['commit', '-am', 'topic']);
    runGit(wtDir, ['checkout', 'wtbranch']);
    fs.writeFileSync(path.join(wtDir, 'file.txt'), 'wtbranch\n');
    runGit(wtDir, ['commit', '-am', 'wtbranch change']);
    runGit(wtDir, ['checkout', 'topic']);
    runGit(wtDir, ['rebase', 'wtbranch'], true);

    const status = await getGitStatus(wtDir);
    expect(status.rebaseInProgress).toBeTruthy();
    expect(status.rebaseInProgress.headName).toBe('topic');
    expect(status.rebaseInProgress.onto).toHaveLength(7);
  });

  it('reports no in-progress operation in a clean linked worktree', async () => {
    if (!canRunGit()) return;
    const baseDir = createTempDir();
    initRepo(baseDir);
    const wtDir = addLinkedWorktree(baseDir);

    const status = await getGitStatus(wtDir);
    expect(status.mergeInProgress ?? null).toBeNull();
    expect(status.rebaseInProgress ?? null).toBeNull();
    expect(status.isClean).toBe(true);
  });
});
