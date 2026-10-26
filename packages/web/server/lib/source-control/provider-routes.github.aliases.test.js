import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerGitHubRoutes } from './provider-routes.github.test-support.js';

// Every account route keeps its `/api/github` alias beside the canonical path.
const accountRoutes = [
  ['get', '/auth/status'],
  ['get', '/auth/accounts'],
  ['post', '/auth/start'],
  ['post', '/auth/complete'],
  ['post', '/auth/token'],
  ['post', '/auth/activate'],
  ['delete', '/auth'],
  ['get', '/me'],
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
const retiredResource = { error: 'Legacy GitHub repository API is retired', code: 'SOURCE_CONTROL_CONTEXT_REQUIRED' };

/** A real express app that also records the paths each route was registered under. */
function recordingApp() {
  const app = express();
  const routes = [];
  for (const method of ['get', 'post', 'delete']) {
    const register = app[method].bind(app);
    app[method] = (paths, ...handlers) => {
      routes.push({ method, paths });
      return register(paths, ...handlers);
    };
  }
  return { app, routes };
}

describe('GitHub source-control route aliases', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-aliases-'));
  const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;

  beforeAll(() => { process.env.OPENCHAMBER_DATA_DIR = dataDir; });
  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps account-management aliases while isolating canonical resources and retiring ambient resources', async () => {
    const { app, routes } = recordingApp();
    app.use(express.json());
    registerGitHubRoutes(app);

    for (const [method, suffix] of accountRoutes) {
      expect(routes).toContainEqual({ method, paths: [`/api/github${suffix}`, `/api/source-control/github${suffix}`] });
    }
    // `/auth/gh-cli` is an extra name of `/auth/cli`, under both prefixes.
    expect(routes).toContainEqual({
      method: 'post',
      paths: ['/api/github/auth/cli', '/api/source-control/github/auth/cli', '/api/github/auth/gh-cli', '/api/source-control/github/auth/gh-cli'],
    });
    for (const suffix of [...getResourceSuffixes, ...postResourceSuffixes]) {
      expect(routes).toContainEqual(expect.objectContaining({ paths: `/api/source-control/github${suffix}` }));
      expect(routes).not.toContainEqual(expect.objectContaining({
        paths: [`/api/github${suffix}`, `/api/source-control/github${suffix}`],
      }));
    }

    // An alias answers exactly as its canonical path does.
    const legacyAccounts = await request(app).get('/api/github/auth/accounts').expect(200);
    const canonicalAccounts = await request(app).get('/api/source-control/github/auth/accounts').expect(200);
    expect(legacyAccounts.body).toEqual(canonicalAccounts.body);
    expect(legacyAccounts.body).toMatchObject({ provider: 'github', instance: 'github.com' });
    for (const prefix of ['/api/github', '/api/source-control/github']) {
      await request(app).post(`${prefix}/auth/complete`).send({}).expect(400, { error: 'flowId is required' });
      await request(app).delete(`${prefix}/auth`).expect(400, { error: 'accountId is required' });
    }

    for (const suffix of getResourceSuffixes) {
      await request(app).get(`/api/github${suffix}`).expect(410, retiredResource);
    }
    for (const suffix of postResourceSuffixes) {
      await request(app).post(`/api/github${suffix}`).expect(410, retiredResource);
    }
    for (const prefix of ['/api/github', '/api/source-control/github']) {
      await request(app).get(`${prefix}/me`).expect(410, {
        error: 'GitHub account user route is retired', code: 'SOURCE_CONTROL_ACCOUNT_CONTEXT_REQUIRED',
      });
    }
  });

  it('switches the gh CLI through either name of the route', async () => {
    const app = express();
    app.use(express.json());
    registerGitHubRoutes(app);

    for (const suffix of ['/auth/cli', '/auth/gh-cli']) {
      for (const prefix of ['/api/github', '/api/source-control/github']) {
        const off = await request(app).post(`${prefix}${suffix}`).send({ disabled: true }).expect(200);
        expect(off.body).toMatchObject({ disabled: true });
        const on = await request(app).post(`${prefix}${suffix}`).send({ disabled: false }).expect(200);
        expect(on.body).toMatchObject({ disabled: false });
      }
    }
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

  it('lists a named GitHub Enterprise host as a PAT candidate', async () => {
    const app = express();
    registerGitHubRoutes(app);

    const response = await request(app)
      .get('/api/source-control/github/capabilities')
      .query({ instance: 'github.example.com' })
      .expect(200);
    expect(response.body.identity).toEqual({ provider: 'github', instance: 'github.example.com' });
    expect(response.body.authenticationMethods).toMatchObject({
      device: { available: false, reason: 'invalid-client' },
      pat: { available: true },
    });
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
