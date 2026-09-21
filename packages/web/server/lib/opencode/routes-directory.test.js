import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    fsPromises: { mkdir: vi.fn(async () => undefined) },
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    readSettingsFromDisk: vi.fn(async () => ({ projects: [] })),
    sanitizeProjects: (projects) => projects,
    persistSettings: vi.fn(async (settings) => settings),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OpenCode project directory route', () => {
  it('creates and activates a requested project outside the active workspace', async () => {
    const { app, dependencies } = createApp();

    const response = await request(app)
      .post('/api/opencode/directory')
      .send({ path: '/projects/testing-one', create: true })
      .expect(200);

    expect(dependencies.fsPromises.mkdir).toHaveBeenCalledWith('/projects/testing-one', { recursive: true });
    expect(dependencies.validateDirectoryPath).toHaveBeenCalledWith('/projects/testing-one');
    expect(response.body).toMatchObject({ success: true, path: '/projects/testing-one' });
  });

  it('does not create a directory for the existing activation flow', async () => {
    const { app, dependencies } = createApp();

    await request(app)
      .post('/api/opencode/directory')
      .send({ path: '/projects/existing' })
      .expect(200);

    expect(dependencies.fsPromises.mkdir).not.toHaveBeenCalled();
  });
});
