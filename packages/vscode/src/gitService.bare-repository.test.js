import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { checkIsGitRepository, listGitWorktrees } = await import('./gitService.ts?bare-repository-test');

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-git-'));
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

const createSourceRepository = () => {
  const source = createTempDir();
  runGit(source, ['init', '-b', 'main']);
  runGit(source, ['config', 'user.email', 'test@example.com']);
  runGit(source, ['config', 'user.name', 'Test']);
  runGit(source, ['commit', '--allow-empty', '-m', 'init']);
  return source;
};

describe('VS Code git service with a bare repository', () => {
  it('treats a bare repository as a git repository and lists its linked worktrees', async () => {
    if (!canRunGit()) return;

    const source = createSourceRepository();

    // Two bare layouts in the wild: a `clone --bare` directory whose git dir
    // is the directory itself, and one whose git dir is a `.git` child.
    for (const bareRoot of [path.join(createTempDir(), 'repo.git'), path.join(createTempDir(), 'repo')]) {
      const gitDir = bareRoot.endsWith('.git') ? bareRoot : path.join(bareRoot, '.git');
      fs.mkdirSync(path.dirname(gitDir), { recursive: true });
      runGit(source, ['clone', '--bare', source, gitDir]);
      const linked = path.join(createTempDir(), 'linked');
      runGit(gitDir, ['worktree', 'add', linked, 'main']);

      for (const directory of [bareRoot, gitDir, linked]) {
        expect(await checkIsGitRepository(directory)).toBe(true);
        const entries = await listGitWorktrees(directory);
        // The bare repository lists itself as a worktree; it has no working
        // tree, so only the linked checkout is a worktree anyone can open.
        expect(entries.map((entry) => fs.realpathSync(entry.path))).toEqual([fs.realpathSync(linked)]);
        expect(entries[0].branch).toBe('main');
      }
    }
  });

  it('keeps non-repository directories and plain checkouts answering as before', async () => {
    if (!canRunGit()) return;

    const nonGit = createTempDir();
    expect(await checkIsGitRepository(nonGit)).toBe(false);
    expect(await listGitWorktrees(nonGit)).toEqual([]);

    const repo = createSourceRepository();
    expect(await checkIsGitRepository(repo)).toBe(true);
    const entries = await listGitWorktrees(repo);
    expect(entries.map((entry) => fs.realpathSync(entry.path))).toEqual([fs.realpathSync(repo)]);
    expect(entries[0].branch).toBe('main');
  });

  it("reports a repository Git refuses in Git's words instead of as no repository", async () => {
    if (!canRunGit()) return;

    const repo = createSourceRepository();
    expect(await checkIsGitRepository(path.join(createTempDir(), 'missing'))).toBe(false);
    // The runner may trust every directory; keep that outside configuration from
    // bypassing the ownership check this test is meant to exercise.
    const keys = ['GIT_TEST_ASSUME_DIFFERENT_OWNER', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const globalConfig = path.join(createTempDir(), 'empty-gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_COUNT = '0';
    delete process.env.GIT_CONFIG_PARAMETERS;
    // Git's own switch for a repository owned by someone else.
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    try {
      const error = await checkIsGitRepository(repo).catch((caught) => caught);
      expect(error).toMatchObject({ code: 'GIT_REPOSITORY_UNREADABLE' });
      expect(error.message).toContain('safe.directory');
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});
