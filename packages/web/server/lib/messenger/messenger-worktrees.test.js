import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { sanitizeWorktreeName, mergeBridgeWorktree } from './messenger-worktrees.js';

describe('sanitizeWorktreeName', () => {
  test('lowercases, hyphenates and strips specials', () => {
    expect(sanitizeWorktreeName('My Feature')).toBe('my-feature');
    expect(sanitizeWorktreeName('Fix Bug #123')).toBe('fix-bug-123');
    expect(sanitizeWorktreeName('  Add   Auth  ')).toBe('add-auth');
    expect(sanitizeWorktreeName('***')).toBe('');
  });
});

describe('mergeBridgeWorktree (local repo without remote)', () => {
  const ROOT = path.join(os.tmpdir(), `oc-bridge-worktree-${Date.now()}`);
  const REPO = path.join(ROOT, 'repo');
  const WT = path.join(ROOT, 'wt-feature');

  const git = (cwd, cmd) => execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString();

  beforeAll(() => {
    mkdirSync(REPO, { recursive: true });
    git(REPO, 'init -b main');
    git(REPO, 'config user.email t@t.t');
    git(REPO, 'config user.name t');
    writeFileSync(path.join(REPO, 'base.txt'), 'base\n');
    git(REPO, 'add -A');
    git(REPO, 'commit -m base');
    git(REPO, `worktree add -b feature "${WT}" main`);
    // configure identity for the worktree too (shares config, but be safe)
    writeFileSync(path.join(WT, 'feature.txt'), 'feature\n');
    git(WT, 'add -A');
    git(WT, 'commit -m feat1');
    writeFileSync(path.join(WT, 'feature.txt'), 'feature v2\n');
    git(WT, 'add -A');
    git(WT, 'commit -m feat2');
  });

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  test('refuses to merge with uncommitted changes', async () => {
    writeFileSync(path.join(WT, 'dirty.txt'), 'dirty\n');
    const result = await mergeBridgeWorktree({ worktreeDir: WT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('uncommitted changes');
    rmSync(path.join(WT, 'dirty.txt'));
  });

  test('squash-merges the worktree branch into main locally', async () => {
    const result = await mergeBridgeWorktree({ worktreeDir: WT });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Merged `feature` into `main`');
    expect(result.summary).toContain('2 commits squashed');
    // main now contains the squashed change
    const show = git(REPO, 'show main:feature.txt');
    expect(show).toBe('feature v2\n');
    // exactly one commit landed on main
    const count = git(REPO, 'rev-list --count main').trim();
    expect(count).toBe('2'); // base + squashed feature
  });

  test('reports nothing to merge when re-run', async () => {
    const result = await mergeBridgeWorktree({ worktreeDir: WT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nothing to merge');
  });
});
