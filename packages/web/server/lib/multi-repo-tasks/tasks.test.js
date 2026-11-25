import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask, inspectTask, removeTask } from './tasks.js';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const savedEnv = { ...process.env };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let root;
let reposDir;
let tasksDir;

const makeRepo = (name, { defaultBranch = 'main', parent = reposDir } = {}) => {
  const origin = path.join(root, 'remotes', name);
  const checkout = path.join(parent, name);
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  git(root, 'init', '-q', '--bare', `--initial-branch=${defaultBranch}`, origin);
  git(root, 'clone', '-q', origin, checkout);
  fs.writeFileSync(path.join(checkout, 'README.md'), name);
  fs.writeFileSync(path.join(checkout, '.gitignore'), 'local.env\nbuild/\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-qm', 'Initial');
  git(checkout, 'push', '-q', 'origin', defaultBranch);
  git(checkout, 'remote', 'set-head', 'origin', '--auto');
  return checkout;
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-tasks-')));
  reposDir = path.join(root, 'repos');
  tasksDir = path.join(root, 'tasks');
  fs.mkdirSync(reposDir);
  Object.assign(process.env, gitEnv);
});

afterEach(() => {
  for (const key of Object.keys(gitEnv)) {
    if (key in savedEnv) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('multi-repo tasks', () => {
  it('starts each worktree from its own default branch on the prefixed task branch', async () => {
    makeRepo('api', { defaultBranch: 'main' });
    makeRepo('ios', { defaultBranch: 'master' });

    const task = await createTask({ reposDir, tasksDir, name: 'search', branchPrefix: 'me/', repositories: ['api', 'ios'] });

    expect(task.branch).toBe('me/search');
    for (const [repo, base] of [['api', 'origin/main'], ['ios', 'origin/master']]) {
      const worktree = path.join(task.path, repo);
      expect(git(worktree, 'branch', '--show-current')).toBe('me/search');
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(path.join(reposDir, repo), 'rev-parse', base));
    }
    expect(fs.readFileSync(path.join(task.path, 'AGENTS.md'), 'utf8')).toContain('branch `me/search`');
    await expect(createTask({ reposDir, tasksDir, name: 'bad', branchPrefix: 'no-slash', repositories: ['api'] }))
      .rejects.toThrow('branch prefix');
  });

  it('copies .worktreeinclude files and leaves them out of the deletion warning until edited', async () => {
    const ios = makeRepo('ios');
    fs.writeFileSync(path.join(ios, '.worktreeinclude'), 'local.env\nnotes.txt\n');
    fs.writeFileSync(path.join(ios, 'local.env'), 'TOKEN=fixture\n');
    fs.writeFileSync(path.join(ios, 'notes.txt'), 'not ignored, so not copied');

    const task = await createTask({ reposDir, tasksDir, name: 'copy', repositories: ['ios'] });
    const worktree = path.join(task.path, 'ios');
    expect(fs.readFileSync(path.join(worktree, 'local.env'), 'utf8')).toBe('TOKEN=fixture\n');
    expect(fs.existsSync(path.join(worktree, 'notes.txt'))).toBe(false);

    fs.mkdirSync(path.join(worktree, 'build'));
    fs.writeFileSync(path.join(worktree, 'build', 'out.o'), 'binary');
    let inspection = await inspectTask(task.path);
    expect(inspection.problems).toEqual([]);
    expect(inspection.repositories[0].ignored).toEqual(['build/']);

    fs.writeFileSync(path.join(worktree, 'local.env'), 'TOKEN=edited\n');
    inspection = await inspectTask(task.path);
    expect(inspection.repositories[0].ignored).toEqual(expect.arrayContaining(['build/', 'local.env']));
  });

  it('refuses to delete while work is uncommitted or unpushed, then deletes cleanly', async () => {
    makeRepo('api');
    makeRepo('web');
    const task = await createTask({ reposDir, tasksDir, name: 'guard', repositories: ['api', 'web'] });

    fs.writeFileSync(path.join(task.path, 'api', 'draft.md'), 'keep');
    git(path.join(task.path, 'web'), 'commit', '-q', '--allow-empty', '-m', 'Local only');
    await expect(removeTask(task.path)).rejects.toMatchObject({
      problems: expect.arrayContaining(['api: uncommitted changes', 'web: 1 commit(s) not pushed']),
    });
    expect(fs.existsSync(path.join(task.path, 'api'))).toBe(true);

    fs.rmSync(path.join(task.path, 'api', 'draft.md'));
    git(path.join(task.path, 'web'), 'push', '-q', 'origin', 'HEAD');
    git(path.join(reposDir, 'api'), 'config', 'status.showUntrackedFiles', 'no');
    fs.writeFileSync(path.join(task.path, '.DS_Store'), '');
    await removeTask(task.path);
    expect(fs.existsSync(task.path)).toBe(false);
    expect(git(path.join(reposDir, 'web'), 'branch', '--list', 'guard')).toBe('');
  });

  it('initialises submodules, guards their unpushed commits and removes the worktree', async () => {
    const libraries = path.join(root, 'libraries');
    fs.mkdirSync(libraries);
    makeRepo('lib', { parent: libraries });
    const app = makeRepo('app');
    git(app, 'submodule', 'add', '-q', path.join(root, 'remotes', 'lib'), 'lib');
    git(app, 'commit', '-qm', 'Add lib');
    git(app, 'push', '-q', 'origin', 'main');

    const task = await createTask({ reposDir, tasksDir, name: 'sub', repositories: ['app'] });
    const submodule = path.join(task.path, 'app', 'lib');
    expect(fs.readFileSync(path.join(submodule, 'README.md'), 'utf8')).toBe('lib');

    git(submodule, 'commit', '-q', '--allow-empty', '-m', 'Local only');
    const inspection = await inspectTask(task.path);
    expect(inspection.problems).toContain('app/lib: 1 submodule commit(s) not pushed');

    git(submodule, 'reset', '-q', '--hard', 'HEAD~1');
    git(path.join(task.path, 'app'), 'config', 'submodule.lib.ignore', 'all');
    fs.writeFileSync(path.join(submodule, 'README.md'), 'edited inside the submodule');
    expect((await inspectTask(task.path)).problems).toContain('app/lib: uncommitted changes');
    git(submodule, 'checkout', '-q', '--', 'README.md');
    await removeTask(task.path);
    expect(fs.existsSync(task.path)).toBe(false);
  });
});
