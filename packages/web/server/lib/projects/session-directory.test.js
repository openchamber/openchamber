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
    openCodeTrust: { assess: vi.fn(async (directory) => ({ trusted: true, assessment: { directory, repositoryKey: directory } })) },
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

  it('reuses the project that registered a linked worktree\'s repository', async () => {
    const repository = { '/kept': '/kept/.git', '/worktrees/feature': '/kept/.git' };
    const emitWorktreeChanged = vi.fn();
    const f = fixture({
      resolveSessionDirectory: async () => '/worktrees/feature',
      openCodeTrust: { assess: async (directory) => ({ trusted: true, assessment: { directory, repositoryKey: repository[directory] ?? directory } }) },
      emitWorktreeChanged,
      linkedWorktreeRoot: async (directory) => (directory === '/worktrees/feature' ? directory : null),
    });
    const response = await f.adopt('/worktrees/feature').expect(200);
    expect(response.body.project.id).toBe('kept');
    expect(f.projects).toHaveLength(1);
    expect(emitWorktreeChanged).toHaveBeenCalledWith(expect.objectContaining({ directories: ['/kept', '/worktrees/feature'] }));
  });

  it('skips a project whose assessment hangs instead of holding the write queue', async () => {
    const f = fixture({
      resolveSessionDirectory: async () => '/worktrees/feature',
      openCodeTrust: {
        assess: (directory) => (directory === '/kept'
          ? new Promise(() => {})
          : Promise.resolve({ trusted: true, assessment: { directory, repositoryKey: '/kept/.git' } })),
      },
      linkedWorktreeRoot: async () => '/worktrees/feature',
    });
    const response = await f.adopt('/worktrees/feature').expect(200);
    expect(response.body.project.path).toBe('/worktrees/feature');
  }, 10_000);

  it('registers a sibling folder of a registered checkout as its own project', async () => {
    const f = fixture({
      resolveSessionDirectory: async () => '/repo/tools',
      openCodeTrust: { assess: async (directory) => ({ trusted: true, assessment: { directory, repositoryKey: '/repo/.git' } }) },
      linkedWorktreeRoot: async () => null,
    });
    f.projects.splice(0, 1, { id: 'app', path: '/repo/app' });
    const response = await f.adopt('/repo/tools').expect(200);
    expect(response.body.project.path).toBe('/repo/tools');
    expect(f.projects.map(entry => entry.path)).toEqual(['/repo/app', '/repo/tools']);
  });

  it('registers a sibling folder inside a linked checkout as its own project', async () => {
    const f = fixture({
      resolveSessionDirectory: async () => '/linked/tools',
      openCodeTrust: { assess: async (directory) => ({ trusted: true, assessment: { directory, repositoryKey: '/repo/.git' } }) },
      linkedWorktreeRoot: async () => '/linked',
    });
    f.projects.splice(0, 1, { id: 'app', path: '/linked/app' });
    const response = await f.adopt('/linked/tools').expect(200);
    expect(response.body.project.path).toBe('/linked/tools');
  });

  it('refuses untrusted configuration at the write boundary', async () => {
    const f = fixture({ openCodeTrust: { assess: async () => ({ trusted: false, assessment: {} }) } });
    const response = await f.adopt().expect(403);
    expect(response.body.code).toBe('opencode_trust_required');
    expect(f.projects).toHaveLength(1);
  });

  it('refuses configuration changed after the initial check', async () => {
    const assess = vi.fn().mockResolvedValueOnce({ trusted: true }).mockResolvedValueOnce({ trusted: false, assessment: {} });
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
