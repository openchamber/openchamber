import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
  workspace: { fs: { readFile: async () => new Uint8Array() } },
}));

const { canonicalizeWorktreeState } = await import('./gitService.ts?canonical-attention-test');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-canon-'));
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

const addLinkedWorktree = (baseDir) => {
  const parent = createTempDir();
  const wtDir = path.join(parent, 'linked');
  runGit(baseDir, ['worktree', 'add', '-b', 'wtbranch', wtDir, 'main']);
  runGit(wtDir, ['config', 'user.email', 'test@example.com']);
  runGit(wtDir, ['config', 'user.name', 'Test']);
  return wtDir;
};

const makeCherryPickConflict = (dir, base) => {
  runGit(dir, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'feature\n');
  runGit(dir, ['commit', '-am', 'feature change']);
  const sha = runGit(dir, ['rev-parse', 'HEAD']).trim();
  runGit(dir, ['checkout', base]);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'other\n');
  runGit(dir, ['commit', '-am', 'other change']);
  runGit(dir, ['cherry-pick', sha], true);
};

const makeRebaseConflict = (dir, base) => {
  runGit(dir, ['checkout', '-b', 'topic']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'topic\n');
  runGit(dir, ['commit', '-am', 'topic change']);
  runGit(dir, ['checkout', base]);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base change\n');
  runGit(dir, ['commit', '-am', 'base change']);
  runGit(dir, ['checkout', 'topic']);
  runGit(dir, ['rebase', base], true);
};

const makeRevertConflict = (dir, base) => {
  runGit(dir, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'feature\n');
  runGit(dir, ['commit', '-am', 'feature change']);
  const sha = runGit(dir, ['rev-parse', 'HEAD']).trim();
  runGit(dir, ['checkout', base]);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'other\n');
  runGit(dir, ['commit', '-am', 'other change']);
  runGit(dir, ['revert', '--no-commit', sha], true);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code canonicalizeWorktreeState attention in linked worktrees (#655)', () => {
  it('reports cherry-pick in the main worktree (control)', async () => {
    if (!canRunGit()) return;
    const dir = createTempDir();
    initRepo(dir);
    makeCherryPickConflict(dir, 'main');

    const state = await canonicalizeWorktreeState(dir);
    expect(state.attentionReason).toBe('cherry-pick');
  });

  it('reports cherry-pick in a linked worktree', async () => {
    if (!canRunGit()) return;
    const baseDir = createTempDir();
    initRepo(baseDir);
    const wtDir = addLinkedWorktree(baseDir);
    makeCherryPickConflict(wtDir, 'wtbranch');

    // .git is a file in a linked worktree; CHERRY_PICK_HEAD lives in the real gitdir.
    expect(fs.statSync(path.join(wtDir, '.git')).isFile()).toBe(true);

    const state = await canonicalizeWorktreeState(wtDir);
    expect(state.attentionReason).toBe('cherry-pick');
  });

  it('reports rebase in a linked worktree', async () => {
    if (!canRunGit()) return;
    const baseDir = createTempDir();
    initRepo(baseDir);
    const wtDir = addLinkedWorktree(baseDir);
    makeRebaseConflict(wtDir, 'wtbranch');

    const state = await canonicalizeWorktreeState(wtDir);
    expect(state.attentionReason).toBe('rebase');
  });

  it('reports revert in a linked worktree', async () => {
    if (!canRunGit()) return;
    const baseDir = createTempDir();
    initRepo(baseDir);
    const wtDir = addLinkedWorktree(baseDir);
    makeRevertConflict(wtDir, 'wtbranch');

    const state = await canonicalizeWorktreeState(wtDir);
    expect(state.attentionReason).toBe('revert');
  });

  it('reports no attention reason in a clean linked worktree', async () => {
    if (!canRunGit()) return;
    const baseDir = createTempDir();
    initRepo(baseDir);
    const wtDir = addLinkedWorktree(baseDir);

    const state = await canonicalizeWorktreeState(wtDir);
    expect(state.attentionReason ?? null).toBeNull();
    expect(state.worktreeStatus).toBe('ready');
  });
});
