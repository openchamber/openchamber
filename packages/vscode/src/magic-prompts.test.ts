import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProjectSetupStore } from './bridge-project-setup-runtime';
import {
  createMagicPromptService,
  repositoryOfGitResult,
  workspaceProjectsOf,
  type MagicPromptRequest,
  type RepositoryWorktrees,
} from './magic-prompts';

// Storage, selectors and precedence are the server's modules, tested in
// packages/web/server/lib/magic-prompts. These tests cover what the extension
// host adds: workspace folders as projects, the shared-file writer, and owner
// resolution through `git worktree list`.

const request = (overrides: Partial<MagicPromptRequest> & Pick<MagicPromptRequest, 'method'>): MagicPromptRequest => ({
  id: null,
  projectId: [],
  scope: [],
  sessionDirectory: [],
  text: null,
  bodyNamesSelector: false,
  ...overrides,
});

const sharedPathOf = (repo: string) => path.join(repo, '.openchamber', 'project.json');
const readJson = async (filePath: string) => JSON.parse(await fs.promises.readFile(filePath, 'utf8'));

describe('magic prompts in the extension host', () => {
  test('a workspace folder keeps its project prompts in its shared file and resets them on their own', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-magic-prompts-'));
    try {
      const repo = path.join(root, 'repo');
      await fs.promises.mkdir(path.dirname(sharedPathOf(repo)), { recursive: true });
      await fs.promises.writeFile(sharedPathOf(repo), JSON.stringify({ version: 1, setupWorktree: ['bun install'] }));
      // The UI names the folder with a trailing slash; the id must still match its project.
      const [project] = workspaceProjectsOf([{ path: `${repo}/` }]);
      const service = createMagicPromptService({
        globalFilePath: path.join(root, 'config', 'magic-prompts.json'),
        sharedFiles: createProjectSetupStore(path.join(root, 'projects')),
        listProjects: () => [project],
        repositoryOf: async () => null,
      });
      const projectScope = { scope: ['project'], projectId: [project.id] };

      await service.handle(request({ method: 'PUT', id: 'plan.todo.visible', text: 'Global' }));
      assert.equal((await service.handle(request({ method: 'PUT', id: 'plan.todo.instructions', text: '', ...projectScope }))).status, 200);
      assert.deepEqual(await service.overridesForDirectory(path.join(repo, 'src')), { 'plan.todo.visible': 'Global', 'plan.todo.instructions': '' });

      await service.handle(request({ method: 'DELETE', ...projectScope }));
      assert.deepEqual(await readJson(sharedPathOf(repo)), { version: 1, setupWorktree: ['bun install'] });
      assert.deepEqual(await service.overridesForDirectory(repo), { 'plan.todo.visible': 'Global' });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('a linked worktree folder uses the project of the same folder in the main checkout', async () => {
    const ownerFor = async (folders: string[], repository: RepositoryWorktrees | null, directory: string) => {
      const service = createMagicPromptService({
        globalFilePath: '/nonexistent/magic-prompts.json',
        sharedFiles: createProjectSetupStore('/nonexistent/projects'),
        listProjects: () => workspaceProjectsOf(folders.map((folder) => ({ path: folder }))),
        repositoryOf: async () => repository,
      });
      return (await service.ownerOfDirectory(directory))?.path ?? null;
    };
    const repo = { root: '/repo', worktrees: ['/repo', '/wts/one'] };

    for (const [folders, directory, owner] of [
      [['/repo'], '/wts/one/src', '/repo'],
      [['/repo/ai', '/repo/web'], '/wts/one/ai/nested', '/repo/ai'],
      [['/repo/ai'], '/wts/one/docs', null],
      // A worktree opened as its own folder is its own project, also with the parent open.
      [['/repo', '/wts/one'], '/wts/one/src', '/wts/one'],
      [['/repo'], '/repo-copy', null],
    ] as const) {
      assert.equal(await ownerFor([...folders], repo, directory), owner, `${directory} in ${folders.join(', ')}`);
    }
  });

  test('a git failure or a broken project file fails the read instead of giving global prompts', async () => {
    const root = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-magic-prompts-git-')));
    try {
      const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANGUAGE: '' } });
      const repo = path.join(root, 'repo');
      const worktree = path.join(root, 'wt');
      await fs.promises.mkdir(repo, { recursive: true });
      await fs.promises.writeFile(path.join(repo, 'README.md'), 'x\n');
      git(repo, 'init', '-q');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
      const service = createMagicPromptService({
        globalFilePath: path.join(root, 'config', 'magic-prompts.json'),
        sharedFiles: createProjectSetupStore(path.join(root, 'projects')),
        listProjects: () => workspaceProjectsOf([{ path: repo }]),
        repositoryOf: async (directory) => {
          const result = git(directory, 'worktree', 'list', '--porcelain');
          return repositoryOfGitResult({ stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 });
        },
      });

      await fs.promises.mkdir(path.dirname(sharedPathOf(repo)), { recursive: true });
      await fs.promises.writeFile(sharedPathOf(repo), JSON.stringify({ version: 1, magicPrompts: { 'plan.todo.visible': 'Repo' } }));
      assert.equal((await service.overridesForDirectory(worktree))['plan.todo.visible'], 'Repo');

      await fs.promises.writeFile(sharedPathOf(repo), '{ broken');
      await assert.rejects(service.overridesForDirectory(worktree), /project\.json cannot be read/);

      assert.equal(repositoryOfGitResult({ stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', exitCode: 128 }), null);
      assert.throws(() => repositoryOfGitResult({ stdout: '', stderr: 'fatal: detected dubious ownership in repository at /repo\n', exitCode: 128 }), /dubious ownership/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
