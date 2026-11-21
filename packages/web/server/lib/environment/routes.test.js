import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerEnvironmentRoutes } from './routes.js';
import { createEnvironmentStore } from './store.js';

describe('environment routes', () => {
  let root;
  let store;
  let runtime;
  let app;
  let onClaudeConfigChanged;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-environment-routes-'));
    store = createEnvironmentStore({ filePath: path.join(root, 'environment.json') });
    runtime = {
      projectStatus: vi.fn(() => null),
      invalidateProject: vi.fn(),
      reloadProject: vi.fn(async () => ({ state: 'applied', count: 3, at: 1 })),
    };
    app = express();
    app.use(express.json());
    onClaudeConfigChanged = vi.fn();
    registerEnvironmentRoutes(app, {
      store,
      runtime,
      readClaudeConfigDir: () => store.userVariables().CLAUDE_CONFIG_DIR,
      onClaudeConfigChanged,
      listProjects: async () => [{ id: 'path_project', path: '/repo' }],
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stores user variables and never answers a value', async () => {
    const saved = await request(app).put('/api/environment').send({ variables: { API_TOKEN: 'secret-value' } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ names: ['API_TOKEN'], secrets: [] });

    const read = await request(app).get('/api/environment');
    expect(read.body).toEqual({ names: ['API_TOKEN'], secrets: [] });
    expect(read.text).not.toContain('secret-value');
  });

  it('answers 400 for a malformed update', async () => {
    const response = await request(app).put('/api/environment').send({ variables: { 'BAD NAME': 'x' } });
    expect(response.status).toBe(400);
    expect(onClaudeConfigChanged).not.toHaveBeenCalled();
  });

  it('announces a successfully saved or removed Claude home, without its value', async () => {
    await request(app).put('/api/environment').send({ variables: { OTHER: 'value' } });
    expect(onClaudeConfigChanged).not.toHaveBeenCalled();
    await request(app).put('/api/environment').send({ variables: { CLAUDE_CONFIG_DIR: '/selected' } });
    expect(onClaudeConfigChanged.mock.calls).toEqual([[]]);
    // Saving the same home again leaves the effective selection as it was.
    await request(app).put('/api/environment').send({ variables: { CLAUDE_CONFIG_DIR: '/selected' } });
    expect(onClaudeConfigChanged.mock.calls).toEqual([[]]);
    await request(app).put('/api/environment').send({ variables: { CLAUDE_CONFIG_DIR: null } });
    expect(onClaudeConfigChanged.mock.calls).toEqual([[], []]);
  });

  it('answers 500 when the stored file is broken instead of an empty list', async () => {
    fs.writeFileSync(path.join(root, 'environment.json'), 'broken');
    const response = await request(app).get('/api/environment');
    expect(response.status).toBe(500);
  });

  it('saves a project environment and forgets what the runtime kept for it', async () => {
    const response = await request(app)
      .put('/api/environment/projects/path_project')
      .send({ variables: { DATABASE_URL: 'postgres://user:pw@db' }, command: 'direnv export json' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ names: ['DATABASE_URL'], command: 'direnv export json', secrets: [], status: null });
    expect(response.text).not.toContain('postgres://');
    expect(runtime.invalidateProject).toHaveBeenCalledWith('path_project');
  });

  it('keeps what the runtime kept for a project when only its saved secrets change', async () => {
    const response = await request(app).put('/api/environment/projects/path_project').send({ secrets: { API_TOKEN: 'tok' } });
    expect(response.status).toBe(200);
    expect(response.body.secrets).toEqual(['API_TOKEN']);
    expect(runtime.invalidateProject).not.toHaveBeenCalled();
  });

  it('refuses saved secrets inside an isolated space and keeps its variables working', async () => {
    const spaceStore = createEnvironmentStore({ filePath: path.join(root, 'space.json'), savesSecrets: false });
    const space = express();
    space.use(express.json());
    registerEnvironmentRoutes(space, { store: spaceStore, runtime, listProjects: async () => [] });

    const user = await request(space).put('/api/environment').send({ secrets: { API_TOKEN: 'tok' } });
    expect(user.status).toBe(400);
    const project = await request(space).put('/api/environment/projects/path_project').send({ variables: { DEBUG: '1' }, secrets: { API_TOKEN: 'tok' } });
    expect(project.status).toBe(400);
    expect(spaceStore.projectSecrets('path_project')).toEqual({});
    expect(spaceStore.projectEntry('path_project').variables).toEqual({});
    expect(fs.existsSync(path.join(root, 'space.json'))).toBe(false);

    const variables = await request(space).put('/api/environment').send({ variables: { DEBUG: '1' } });
    expect(variables.status).toBe(200);
  });

  it('refuses a project id that is not one', async () => {
    const response = await request(app).put('/api/environment/projects/__proto__').send({ command: 'x' });
    expect(response.status).toBe(400);
  });

  it('runs the command in the project on reload', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    runtime.projectStatus.mockReturnValue({ state: 'applied', count: 3, at: 1 });
    const response = await request(app).post('/api/environment/projects/path_project/reload');
    expect(response.status).toBe(200);
    expect(runtime.reloadProject).toHaveBeenCalledWith('path_project', '/repo');
    expect(response.body.status).toEqual({ state: 'applied', count: 3, at: 1 });
  });

  it('answers 404 when reloading a project that is not configured', async () => {
    const response = await request(app).post('/api/environment/projects/path_other/reload');
    expect(response.status).toBe(404);
  });
});
