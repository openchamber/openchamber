import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

const createdDirectories = [];
let registerOpenCodeRoutes;
let restoreEnvironment;

const createTempDir = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-worktree-route-')));
  createdDirectories.push(directory);
  return directory;
};

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerOpenCodeRoutes(app, {
    fsPromises: { mkdir: vi.fn(async () => undefined) },
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    // Reads the header or query a desktop or web request carries, the same way
    // the real runtime does, so the route sees the directory it was sent.
    resolveProjectDirectory: async (req) => ({
      ok: true,
      directory: req.query?.directory || req.headers['x-opencode-directory'] || process.cwd(),
    }),
  });
  return app;
};

beforeEach(async () => {
  const previous = process.env.OPENCODE_CONFIG;
  // A managed config on the developer's machine would outrank every project file.
  delete process.env.OPENCODE_CONFIG;
  restoreEnvironment = () => {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = previous;
  };
  vi.resetModules();
  ({ registerOpenCodeRoutes } = await import('./routes.js'));
});

afterEach(() => {
  restoreEnvironment?.();
  for (const directory of createdDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('worktree directory config route', () => {
  it('reports the effective folder, where it came from, and where a save would go', async () => {
    const repo = createTempDir();
    const projectFile = path.join(repo, 'opencode.json');
    fs.writeFileSync(projectFile, JSON.stringify({ worktree: { directory: '../worktrees' } }));
    const app = createApp();

    const response = await request(app)
      .get('/api/config/worktree')
      .query({ directory: repo })
      .expect(200);

    expect(response.body).toMatchObject({
      directory: '../worktrees',
      source: 'project',
      path: projectFile,
      writePath: projectFile,
      locked: false,
    });
  });

  it('writes the folder and reads it back', async () => {
    const repo = createTempDir();
    const projectFile = path.join(repo, 'opencode.json');
    fs.writeFileSync(projectFile, JSON.stringify({ theme: 'opencode' }));
    const app = createApp();

    const saved = await request(app)
      .put('/api/config/worktree')
      .query({ directory: repo })
      .send({ directory: '../worktrees' })
      .expect(200);

    expect(saved.body).toMatchObject({ success: true, changed: true, path: projectFile });
    expect(JSON.parse(fs.readFileSync(projectFile, 'utf8'))).toMatchObject({
      theme: 'opencode',
      worktree: { directory: '../worktrees' },
    });

    const read = await request(app).get('/api/config/worktree').query({ directory: repo }).expect(200);
    expect(read.body).toMatchObject({ directory: '../worktrees', source: 'project' });
  });

  it('clears the key so an inherited folder applies again', async () => {
    const repo = createTempDir();
    fs.writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ worktree: { directory: '../worktrees' } }));
    const app = createApp();

    const cleared = await request(app)
      .put('/api/config/worktree')
      .query({ directory: repo })
      .send({ directory: null })
      .expect(200);

    expect(cleared.body).toMatchObject({ success: true, changed: true });
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'opencode.json'), 'utf8'))).toEqual({});
  });

  it('rejects a folder that is not a string', async () => {
    const app = createApp();

    for (const directory of [42, '', '   ', {}]) {
      const response = await request(app).put('/api/config/worktree').send({ directory }).expect(400);
      expect(response.body).toMatchObject({ error: 'directory must be a non-empty string, or null to clear it' });
    }
  });
});
