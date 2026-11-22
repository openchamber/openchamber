import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { ensureOpenCodeProjectId } = await import('./gitService.ts?project-id-test');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-projectid-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const initRepoWithCommit = (dir) => {
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test');
  runGit(dir, ['add', 'README.md']);
  runGit(dir, ['commit', '-m', 'init']);
  return runGit(dir, ['rev-list', '--max-parents=0', '--all']).trim();
};

describe('VS Code ensureOpenCodeProjectId', () => {
  it('caches the ID in .git/opencode for a plain checkout', async () => {
    if (!canRunGit()) return;
    const repository = createTempDir();
    const root = initRepoWithCommit(repository);
    const commonDir = path.join(repository, '.git');
    const id = await ensureOpenCodeProjectId(repository, commonDir);
    expect(id).toBe(root);
    expect(fs.readFileSync(path.join(commonDir, 'opencode'), 'utf8')).toBe(root);
    await expect(ensureOpenCodeProjectId(repository, commonDir)).resolves.toBe(root);
  });

  it('caches the ID at the top of a bare repository without creating a .git entry', async () => {
    if (!canRunGit()) return;
    const source = createTempDir();
    initRepoWithCommit(source);
    const bare = path.join(createTempDir(), 'repo.git');
    runGit(source, ['clone', '--bare', source, bare]);
    const commonDir = runGit(bare, ['rev-parse', '--absolute-git-dir']).trim();
    const id = await ensureOpenCodeProjectId(bare, commonDir);
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.readFileSync(path.join(commonDir, 'opencode'), 'utf8')).toBe(id);
    expect(fs.existsSync(path.join(bare, '.git'))).toBe(false);
    await expect(ensureOpenCodeProjectId(bare, commonDir)).resolves.toBe(id);
  });

  it('caches the ID in a separate git dir, not through the .git pointer file', async () => {
    if (!canRunGit()) return;
    const parent = createTempDir();
    const separateGitDir = path.join(parent, 'separate.git');
    const worktree = path.join(parent, 'worktree');
    runGit(parent, ['init', '--separate-git-dir=' + separateGitDir, '-b', 'main', worktree]);
    runGit(worktree, ['config', 'user.email', 'test@example.com']);
    runGit(worktree, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(worktree, 'README.md'), '# Test');
    runGit(worktree, ['add', 'README.md']);
    runGit(worktree, ['commit', '-m', 'init']);
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
    const id = await ensureOpenCodeProjectId(worktree, separateGitDir);
    expect(fs.readFileSync(path.join(separateGitDir, 'opencode'), 'utf8')).toBe(id);
    await expect(ensureOpenCodeProjectId(worktree, separateGitDir)).resolves.toBe(id);
  });
});
