import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerSessionProjectRoutes } from './session-directory.js';

const fixture = (overrides = {}) => {
  const projects = [{ id: 'kept', path: '/kept', label: 'Keep me' }];
  const deps = {
    validateDirectoryPath: async directory => ({ ok: true, directory }),
    resolveSessionDirectory: async () => '/outside',
    openCodeTrust: { assess: vi.fn(async () => ({ trusted: true })) },
    registerSessionProject: vi.fn(async (resolve) => {
      const project = await resolve(projects);
      if (!projects.some(entry => entry.id === project.id)) projects.push(project);
      return project;
    }),
    ...overrides,
  };
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerSessionProjectRoutes(app, deps);
  const adopt = (directory = '/outside') => request(app).post('/api/projects/session-directory').send({ sessionId: 'one', directory });
  return { projects, deps, adopt };
};

describe('session destination project registration', () => {
  it('registers an allowed destination once without activating it', async () => {
    const f = fixture();
    await f.adopt().expect(200);
    await f.adopt().expect(200);
    expect(f.projects.map(entry => entry.path)).toEqual(['/kept', '/outside']);
    expect(f.projects[0].label).toBe('Keep me');
  });

  it('reuses a registered ancestor', async () => {
    const f = fixture({ resolveSessionDirectory: async () => '/kept/child' });
    const response = await f.adopt('/kept/child').expect(200);
    expect(response.body.project.id).toBe('kept');
    expect(f.projects).toHaveLength(1);
  });

  it('refuses untrusted configuration at the write boundary', async () => {
    const f = fixture({ openCodeTrust: { assess: async () => ({ trusted: false }) } });
    const response = await f.adopt().expect(403);
    expect(response.body.code).toBe('opencode_trust_required');
    expect(f.projects).toHaveLength(1);
  });

  it('refuses configuration changed after the initial check', async () => {
    const assess = vi.fn().mockResolvedValueOnce({ trusted: true }).mockResolvedValueOnce({ trusted: false });
    const f = fixture({ openCodeTrust: { assess } });
    await f.adopt().expect(403);
    expect(f.projects).toHaveLength(1);
  });

  it('rejects an old destination and failed writes without reporting success', async () => {
    const moved = fixture({ resolveSessionDirectory: async () => '/new' });
    await moved.adopt().expect(409);
    expect(moved.deps.registerSessionProject).not.toHaveBeenCalled();
    const failed = fixture({ registerSessionProject: async () => { throw new Error('disk full'); } });
    await failed.adopt().expect(503);
    expect(failed.projects).toHaveLength(1);
  });
});
