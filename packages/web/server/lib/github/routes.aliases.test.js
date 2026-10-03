import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerGitHubRoutes } from './routes.js';

const authSuffixes = [
  '/auth/status',
  '/auth/accounts',
  '/auth/gh-cli',
  '/auth/start',
  '/auth/complete',
  '/auth/activate',
  '/auth',
];
const getResourceSuffixes = [
  '/pr/status',
  '/repo/upstream',
  '/repo/branches',
  '/issues/list',
  '/issues/get',
  '/issues/comments',
  '/pulls/list',
  '/pulls/context',
];
const postResourceSuffixes = [
  '/pr/create',
  '/pr/update',
  '/pr/merge',
  '/pr/ready',
];

describe('GitHub source-control route aliases', () => {
  it('keeps account-management aliases while isolating canonical resources and retiring ambient resources', async () => {
    const routes = [];
    const app = {
      get: vi.fn((paths, handler) => routes.push({ method: 'get', paths, handler })),
      post: vi.fn((paths, handler) => routes.push({ method: 'post', paths, handler })),
      delete: vi.fn((paths, handler) => routes.push({ method: 'delete', paths, handler })),
    };

    registerGitHubRoutes(app);

    for (const suffix of authSuffixes) {
      expect(routes).toContainEqual(expect.objectContaining({
        paths: [`/api/github${suffix}`, `/api/source-control/github${suffix}`],
      }));
    }
    for (const suffix of [...getResourceSuffixes, ...postResourceSuffixes]) {
      expect(routes).toContainEqual(expect.objectContaining({ paths: `/api/source-control/github${suffix}` }));
      expect(routes).not.toContainEqual(expect.objectContaining({
        paths: [`/api/github${suffix}`, `/api/source-control/github${suffix}`],
      }));
    }
    expect(routes).toContainEqual(expect.objectContaining({
      paths: ['/api/github/me'],
    }));

    const server = express();
    registerGitHubRoutes(server);
    for (const suffix of getResourceSuffixes) {
      await request(server).get(`/api/github${suffix}`).expect(410, {
        error: 'Legacy GitHub repository API is retired', code: 'SOURCE_CONTROL_CONTEXT_REQUIRED',
      });
    }
    for (const suffix of postResourceSuffixes) {
      await request(server).post(`/api/github${suffix}`).expect(410, {
        error: 'Legacy GitHub repository API is retired', code: 'SOURCE_CONTROL_CONTEXT_REQUIRED',
      });
    }
    await request(server).get('/api/github/me').expect(410, {
      error: 'GitHub account user route is retired', code: 'SOURCE_CONTROL_ACCOUNT_CONTEXT_REQUIRED',
    });
  });

  it('returns provider-neutral GitHub capabilities', async () => {
    const app = express();
    registerGitHubRoutes(app);

    const response = await request(app)
      .get('/api/source-control/github/capabilities')
      .query({ instance: 'github.com' })
      .expect(200);

    expect(response.body).toEqual({
      identity: { provider: 'github', instance: 'github.com' },
      authentication: true,
      authenticationMethods: {
        device: { available: true },
        pat: { available: false, reason: 'unsupported' },
        cli: { available: true },
      },
      multipleAccounts: true,
      projects: true,
      issues: true,
      changeRequests: true,
      draftChangeRequests: true,
      mergeChangeRequests: true,
      mergeMethods: ['merge', 'squash', 'rebase'],
      ci: true,
    });
  });

  it('rejects unsupported GitHub instances', async () => {
    const app = express();
    registerGitHubRoutes(app);

    await request(app)
      .get('/api/source-control/github/capabilities')
      .query({ instance: 'github.example.com' })
      .expect(400);
  });

  it('returns 501 for canonical bound reads when binding validation is unavailable', async () => {
    const app = express();
    registerGitHubRoutes(app);

    await request(app).get('/api/source-control/github/pulls/list').query({ directory: '/repo' }).expect(501);
    await request(app).get('/api/source-control/github/pulls/context').query({ directory: '/repo', number: 1 }).expect(501);
    await request(app).get('/api/source-control/github/issues/list').query({ directory: '/repo' }).expect(501);
    await request(app).get('/api/source-control/github/issues/get').query({ directory: '/repo', number: 1 }).expect(501);
    await request(app).get('/api/source-control/github/issues/comments').query({ directory: '/repo', number: 1 }).expect(501);
    await request(app).get('/api/source-control/github/repo/upstream').query({ directory: '/repo' }).expect(501);
    await request(app).get('/api/source-control/github/repo/branches').query({ directory: '/repo', owner: 'team', repo: 'project' }).expect(501);
  });
});
