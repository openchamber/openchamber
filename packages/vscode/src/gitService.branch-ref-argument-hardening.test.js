import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const {
  applyGitStash,
  checkoutBranch,
  countGitStashFiles,
  createBranch,
  deleteGitBranch,
  dropGitStash,
  merge,
  popGitStash,
  rebase,
} = await import('./gitService.ts?branch-ref-argument-hardening-test');

const tempDirs = [];
const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-git-'));
  tempDirs.push(dir);
  return dir;
};
const runGit = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (cwd, args) => {
  try { runGit(cwd, args); return true; } catch { return false; }
};
const canRunGit = () => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

const createRepository = () => {
  const repository = createTempDir();
  runGit(repository, ['init', '-b', 'main']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'base\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'init']);
  return repository;
};
const commitReadme = (repository, content, message) => {
  fs.writeFileSync(path.join(repository, 'README.md'), content);
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', message]);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('VS Code git branch/ref arguments with option-like values', () => {
  it('rejects checkout -f and leaves uncommitted work untouched', async () => {
    if (!canRunGit()) return;
    const repository = createRepository();
    fs.writeFileSync(path.join(repository, 'README.md'), 'uncommitted\n');
    await expect(checkoutBranch(repository, '-f')).rejects.toThrow(/option-like/);
    expect(fs.readFileSync(path.join(repository, 'README.md'), 'utf8')).toBe('uncommitted\n');
    expect(runGit(repository, ['branch', '--show-current']).trim()).toBe('main');
    expect(runGit(repository, ['status', '--porcelain'])).toContain('README.md');
  }, 30_000);

  it('rejects option-like create/delete branch args but accepts valid names with slashes and dots', async () => {
    if (!canRunGit()) return;
    const repository = createRepository();
    await expect(createBranch(repository, '--force')).rejects.toThrow(/option-like/);
    await expect(createBranch(repository, 'feature/ok', '--abort')).rejects.toThrow(/option-like/);
    expect(runGit(repository, ['branch', '--list', 'feature/ok']).trim()).toBe('');
    const created = await createBranch(repository, 'feature/with.dots');
    expect(created.success).toBe(true);
    expect(runGit(repository, ['branch', '--list', 'feature/with.dots']).trim()).toContain('feature/with.dots');
    await expect(deleteGitBranch(repository, '-D')).rejects.toThrow(/option-like/);
    expect(runGit(repository, ['branch', '--list', 'feature/with.dots']).trim()).toContain('feature/with.dots');
    const deleted = await deleteGitBranch(repository, 'feature/with.dots');
    expect(deleted.success).toBe(true);
    const checked = await checkoutBranch(repository, 'main');
    expect(checked.success).toBe(true);
  }, 30_000);

  it('rejects merge --abort and leaves the in-progress merge untouched', async () => {
    if (!canRunGit()) return;
    const repository = createRepository();
    runGit(repository, ['checkout', '-b', 'feature/conflict']);
    commitReadme(repository, 'feature\n', 'feature');
    runGit(repository, ['checkout', 'main']);
    commitReadme(repository, 'main\n', 'main');
    expect(tryGit(repository, ['merge', 'feature/conflict'])).toBe(false);
    expect(fs.existsSync(path.join(repository, '.git', 'MERGE_HEAD'))).toBe(true);
    await expect(merge(repository, { branch: '--abort' })).rejects.toThrow(/option-like/);
    expect(fs.existsSync(path.join(repository, '.git', 'MERGE_HEAD'))).toBe(true);
    runGit(repository, ['merge', '--abort']);
  }, 30_000);

  it('rejects rebase --abort and leaves the in-progress rebase untouched', async () => {
    if (!canRunGit()) return;
    const repository = createRepository();
    runGit(repository, ['checkout', '-b', 'feature/rebase']);
    commitReadme(repository, 'feature\n', 'feature');
    runGit(repository, ['checkout', 'main']);
    commitReadme(repository, 'main\n', 'main');
    runGit(repository, ['checkout', 'feature/rebase']);
    expect(tryGit(repository, ['rebase', 'main'])).toBe(false);
    const stateExists = () =>
      fs.existsSync(path.join(repository, '.git', 'rebase-merge')) ||
      fs.existsSync(path.join(repository, '.git', 'rebase-apply'));
    expect(stateExists()).toBe(true);
    await expect(rebase(repository, { onto: '--abort' })).rejects.toThrow(/option-like/);
    expect(stateExists()).toBe(true);
    runGit(repository, ['rebase', '--abort']);
  }, 30_000);

  it('rejects option-like stash refs and keeps legitimate stash operations working', async () => {
    if (!canRunGit()) return;
    const repository = createRepository();
    fs.writeFileSync(path.join(repository, 'README.md'), 'stashed\n');
    runGit(repository, ['stash', 'push', '-m', 'keep-me']);
    expect(runGit(repository, ['stash', 'list'])).toContain('keep-me');
    await expect(applyGitStash(repository, { ref: '--index' })).rejects.toThrow(/option-like/);
    await expect(dropGitStash(repository, { ref: '--force' })).rejects.toThrow(/option-like/);
    await expect(popGitStash(repository, { ref: '--force' })).rejects.toThrow(/option-like/);
    await expect(countGitStashFiles(repository, ['--name-only'])).rejects.toThrow(/option-like/);
    expect(runGit(repository, ['stash', 'list'])).toContain('keep-me');
    const counts = await countGitStashFiles(repository, ['stash@{0}']);
    expect(counts['stash@{0}']).toBe(1);
    const applied = await applyGitStash(repository, { ref: 'stash@{0}' });
    expect(applied.success).toBe(true);
    expect(fs.readFileSync(path.join(repository, 'README.md'), 'utf8')).toBe('stashed\n');
  }, 30_000);

  it('still merges a legitimate branch', async () => {
    if (!canRunGit()) return;
    const repository = createRepository();
    runGit(repository, ['checkout', '-b', 'feature/merge.me']);
    fs.writeFileSync(path.join(repository, 'NEXT.md'), 'next\n');
    runGit(repository, ['add', 'NEXT.md']);
    runGit(repository, ['commit', '-m', 'next']);
    runGit(repository, ['checkout', 'main']);
    const result = await merge(repository, { branch: 'feature/merge.me' });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(repository, 'NEXT.md'))).toBe(true);
  }, 30_000);
});
