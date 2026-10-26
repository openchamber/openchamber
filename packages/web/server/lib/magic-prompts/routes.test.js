import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'os';
import path from 'path';
import * as fsPromises from 'fs/promises';
import { execFileSync } from 'child_process';

import { resolvePrimaryWorktreeRoot, resolveWorktreeTopLevel } from '../git/service.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { registerMagicPromptRoutes } from './routes.js';

const createFixture = async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-magic-prompt-routes-'));
  const dataDir = path.join(tempRoot, 'data');
  const repo = path.join(tempRoot, 'repo');
  await fsPromises.mkdir(dataDir, { recursive: true });
  await fsPromises.mkdir(repo, { recursive: true });
  const projects = [{ id: 'repo', path: repo }];

  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerMagicPromptRoutes(app, {
    fsPromises,
    path,
    openchamberDataDir: dataDir,
    projectConfigRuntime: createProjectConfigRuntime({ fsPromises, path, projectsDirPath: path.join(dataDir, 'projects') }),
    readSettingsFromDisk: async () => ({ projects }),
    sanitizeProjects: (input) => input,
    resolvePrimaryWorktreeRoot,
    resolveWorktreeTopLevel,
  });

  const sharedPathOf = (checkout) => path.join(checkout, '.openchamber', 'project.json');
  const writeShared = async (checkout, document) => {
    await fsPromises.mkdir(path.dirname(sharedPathOf(checkout)), { recursive: true });
    await fsPromises.writeFile(sharedPathOf(checkout), typeof document === 'string' ? document : JSON.stringify(document));
  };
  const setGlobal = (id, text) => request(app).put(`/api/magic-prompts/${id}`).send({ text }).expect(200);
  const setProject = (projectId, id, text) => request(app).put(`/api/magic-prompts/${id}?scope=project&projectId=${projectId}`).send({ text }).expect(200);
  const overridesIn = async (directory) => (await request(app).get(`/api/magic-prompts?${new URLSearchParams({ sessionDirectory: directory })}`).expect(200)).body.overrides;

  return {
    app,
    projects,
    tempRoot,
    repo,
    globalPath: path.join(dataDir, 'magic-prompts.json'),
    sharedPathOf,
    writeShared,
    setGlobal,
    setProject,
    overridesIn,
    cleanup: () => fsPromises.rm(tempRoot, { recursive: true, force: true }),
  };
};

const withFixture = async (run) => {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
};

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

describe('magic prompt routes', () => {
  it('takes the project override, then the global one, then leaves the built-in text to the client', async () => {
    await withFixture(async ({ app, repo, tempRoot, setGlobal, setProject, overridesIn }) => {
      await setGlobal('plan.todo.visible', 'Global visible');
      await setGlobal('plan.todo.instructions', 'Global instructions');
      await setGlobal('git.commit.generate', 'Legacy subject\nLegacy body');
      await setProject('repo', 'plan.todo.instructions', '');

      // An empty project value wins; a legacy combined key is split inside its own scope.
      expect(await overridesIn(path.join(repo, 'src'))).toMatchObject({
        'plan.todo.visible': 'Global visible',
        'plan.todo.instructions': '',
        'git.commit.generate.visible': 'Legacy subject',
        'git.commit.generate.instructions': 'Legacy body',
      });
      expect((await overridesIn(path.join(tempRoot, 'elsewhere')))['plan.todo.instructions']).toBe('Global instructions');

      // Settings reads both scopes of the project apart.
      const view = await request(app).get('/api/magic-prompts?projectId=repo').expect(200);
      expect(view.body.scopes.project).toEqual({ status: 'ok', overrides: { 'plan.todo.instructions': '' } });
      expect(view.body.scopes.global.overrides['plan.todo.visible']).toBe('Global visible');
    });
  });

  it('resets only the scope it names and keeps the rest of the project file', async () => {
    await withFixture(async ({ app, repo, globalPath, sharedPathOf, writeShared, setGlobal, setProject, overridesIn }) => {
      await writeShared(repo, { version: 1, setupWorktree: ['bun install'], futureKey: { a: 1 } });
      await setGlobal('plan.todo.visible', 'Global');
      await setProject('repo', 'plan.todo.visible', 'Project');
      await setProject('repo', 'plan.todo.instructions', 'Project steps');

      await request(app).delete('/api/magic-prompts/plan.todo.visible?scope=project&projectId=repo').expect(200);
      expect(await overridesIn(repo)).toEqual({ 'plan.todo.visible': 'Global', 'plan.todo.instructions': 'Project steps' });

      const globalReset = await request(app).delete('/api/magic-prompts?scope=global&projectId=repo').expect(200);
      expect(globalReset.body.scopes.project.overrides).toEqual({ 'plan.todo.instructions': 'Project steps' });
      expect(JSON.parse(await fsPromises.readFile(globalPath, 'utf8')).overrides).toEqual({});

      await setGlobal('plan.todo.visible', 'Global again');
      await request(app).delete('/api/magic-prompts?scope=project&projectId=repo').expect(200);
      expect(JSON.parse(await fsPromises.readFile(sharedPathOf(repo), 'utf8'))).toEqual({ version: 1, setupWorktree: ['bun install'], futureKey: { a: 1 } });
      expect(await overridesIn(repo)).toEqual({ 'plan.todo.visible': 'Global again' });
    });
  });

  it('gives a worktree folder the project that holds the same folder in the main checkout', async () => {
    await withFixture(async ({ projects, repo, tempRoot, setGlobal, setProject, overridesIn }) => {
      for (const folder of ['ai/nested', 'docs']) {
        await fsPromises.mkdir(path.join(repo, folder), { recursive: true });
        await fsPromises.writeFile(path.join(repo, folder, 'README.md'), 'x\n');
      }
      git(repo, 'init', '-q');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
      const linked = path.join(tempRoot, 'wt', 'feature');
      const own = path.join(tempRoot, 'wt', 'own');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
      git(repo, 'worktree', 'add', '-q', '-b', 'own', own);
      projects.push({ id: 'ai', path: path.join(repo, 'ai') }, { id: 'own', path: own });
      await setGlobal('plan.todo.visible', 'Global');
      for (const id of ['repo', 'ai', 'own']) await setProject(id, 'plan.todo.visible', id);

      const visibleIn = async (directory) => (await overridesIn(directory))['plan.todo.visible'];
      expect(await visibleIn(linked)).toBe('repo');
      expect(await visibleIn(path.join(linked, 'docs'))).toBe('repo');
      expect(await visibleIn(path.join(linked, 'ai', 'nested'))).toBe('ai');
      // A worktree added as a project of its own keeps its own file.
      expect(await visibleIn(path.join(own, 'ai'))).toBe('own');
      // A sibling folder whose name only starts with the checkout's name is not inside it.
      expect(await visibleIn(`${repo}-copy`)).toBe('Global');
    });
  });

  it('keeps the project of a checkout registered through a symlink for its linked worktrees', async () => {
    await withFixture(async ({ projects, repo, tempRoot, setGlobal, setProject, overridesIn }) => {
      await fsPromises.writeFile(path.join(repo, 'README.md'), 'x\n');
      git(repo, 'init', '-q');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
      const linkedRepo = path.join(tempRoot, 'repo-link');
      await fsPromises.symlink(repo, linkedRepo);
      projects.splice(0, projects.length, { id: 'repo', path: linkedRepo });
      const worktree = path.join(tempRoot, 'wt', 'feature');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
      await setGlobal('plan.todo.visible', 'Global');
      await setProject('repo', 'plan.todo.visible', 'repo');

      expect((await overridesIn(worktree))['plan.todo.visible']).toBe('repo');
      expect((await overridesIn(path.join(linkedRepo, 'not-yet')))['plan.todo.visible']).toBe('repo');
    });
  });

  it('fails a read that needs a broken file and never overwrites it', async () => {
    await withFixture(async ({ app, repo, tempRoot, globalPath, sharedPathOf, writeShared, setGlobal }) => {
      await setGlobal('plan.todo.visible', 'Global');
      await writeShared(repo, '{ broken');

      const read = await request(app).get(`/api/magic-prompts?${new URLSearchParams({ sessionDirectory: repo })}`).expect(409);
      expect(read.body.code).toBe('project_prompts_invalid');
      // Settings still shows the readable global scope beside the broken one.
      const view = await request(app).get('/api/magic-prompts?projectId=repo').expect(200);
      expect(view.body.scopes.project.status).toBe('invalid');
      expect(view.body.scopes.global.status).toBe('ok');
      await request(app).put('/api/magic-prompts/plan.todo.visible?scope=project&projectId=repo').send({ text: 'X' }).expect(409);
      await request(app).delete('/api/magic-prompts?scope=project&projectId=repo').expect(409);
      expect(await fsPromises.readFile(sharedPathOf(repo), 'utf8')).toBe('{ broken');

      // A missing project file is no overrides, not an error; a broken global file fails every read.
      await fsPromises.rm(sharedPathOf(repo));
      await fsPromises.writeFile(globalPath, '{ broken');
      const globalRead = await request(app).get(`/api/magic-prompts?${new URLSearchParams({ sessionDirectory: path.join(tempRoot, 'elsewhere') })}`).expect(409);
      expect(globalRead.body.code).toBe('global_prompts_invalid');
      await request(app).put('/api/magic-prompts/plan.todo.visible').send({ text: 'X' }).expect(409);
      expect(await fsPromises.readFile(globalPath, 'utf8')).toBe('{ broken');
    });
  });

  it.each([
    ['projectId without scope', '?projectId=repo', {}, 400],
    ['selectors in the body', '', { scope: 'project', projectId: 'repo' }, 400],
    ['an unknown project', '?scope=project&projectId=nope', {}, 404],
  ])('refuses %s and never writes the global file instead', async (_label, query, extraBody, status) => {
    await withFixture(async ({ app, globalPath }) => {
      await request(app).put(`/api/magic-prompts/plan.todo.visible${query}`).send({ text: 'X', ...extraBody }).expect(status);
      await expect(fsPromises.readFile(globalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
