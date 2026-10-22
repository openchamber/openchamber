import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceControlAuthStore } from './auth-storage.js';
import { createMutationExecutor } from './mutation-executor.js';
import { createSourceControlProviders } from './provider-registry.js';
import { registerSourceControlRoutes } from './routes.js';
import {
  CHANGE, changeRoutes, fakeGerrit, fixtures, ORIGIN, PS3, resolvePlatformApp,
} from '../gerrit/fixtures/fake-fetch.js';

/**
 * Gerrit as a registered built-in: every route the shell gives it, through
 * the real registry (built-in descriptors and loaders), the real route
 * module and the durable mutation executor, against the recorded REST
 * answers. A capability Gerrit turns off answers 501.
 */
const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

const memoryMutations = () => {
  const records = new Map();
  return {
    withExecutionLock: async (_key, operation) => operation(),
    read: async (key) => records.get(key) ?? null,
    claim: async (record) => {
      const existing = records.get(record.key);
      if (existing) return { status: existing.inputDigest === record.inputDigest ? 'existing' : 'conflict', record: existing };
      records.set(record.key, { ...record, state: 'running' });
      return { status: 'claimed', record: records.get(record.key) };
    },
    complete: async (key, _digest, completion) => {
      const completed = { ...records.get(key), state: completion.state };
      if (completion.result !== undefined) completed.result = completion.result;
      records.set(key, completed);
      return completed;
    },
  };
};

async function appWith(extraRoutes = {}, { readLocalRevision = async () => ({ sha: PS3, changeId: fixtures.changeId }) } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-gerrit-routes-'));
  directories.push(directory);
  const gerrit = fakeGerrit(changeRoutes(extraRoutes));
  const authStore = createSourceControlAuthStore({ filePath: path.join(directory, 'source-control-auth.json') });
  const providers = createSourceControlProviders({
    authStore,
    hostServices: {
      gerrit: {
        fetch: gerrit.fetch,
        resolveProjects: resolvePlatformApp,
        readLocalRevision,
        readUpstreamBranch: async () => 'master',
      },
    },
  });
  let accountId = '';
  const readContext = () => ({
    directory: '/repo', repositoryId: 'repo-1', provider: 'gerrit', instance: ORIGIN, accountId, bindingRevision: 2, primaryRemote: 'origin',
  });
  const app = express();
  app.use(express.json());
  registerSourceControlRoutes(app, {
    providers,
    bindingService: {
      validateReadContext: vi.fn(async () => readContext()),
      validateMutationContext: vi.fn(async (body) => ({ ...readContext(), idempotencyKey: body.idempotencyKey, target: body.target })),
      accountUnavailable: vi.fn(async () => {}), accountConnected: vi.fn(async () => {}),
    },
    identityProvisioning: {
      backfillAccountIdentities: vi.fn(async () => {}), ensureAccountIdentity: vi.fn(async () => {}), repointAccountIdentities: vi.fn(async () => {}),
    },
    mutationExecutor: createMutationExecutor({ store: memoryMutations() }),
  });
  const connected = await request(app).post('/api/source-control/gerrit/auth/token').query({ instance: ORIGIN })
    .send({ token: 'http-pw', username: 'alice' });
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
  const accounts = await request(app).get('/api/source-control/gerrit/auth/accounts').query({ instance: ORIGIN }).expect(200);
  accountId = accounts.body.accounts[0].id;
  const bound = { instance: ORIGIN, directory: '/repo', repositoryId: 'repo-1', bindingRevision: '2', primaryRemote: 'origin', accountId };
  return { app, gerrit, bound, accountId };
}

const target = { project: { owner: 'platform', name: 'app' }, number: 42, headSha: PS3 };

describe('Gerrit through the route shell', () => {
  it('is listed last among the built-ins and answers capabilities and account routes', async () => {
    const { app, accountId } = await appWith();
    const providers = await request(app).get('/api/source-control/providers').expect(200);
    expect(providers.body.providers.map((provider) => provider.id)).toEqual(['github', 'gitlab', 'gitea', 'gerrit']);
    const capabilities = await request(app).get('/api/source-control/gerrit/capabilities').query({ instance: ORIGIN }).expect(200);
    expect(capabilities.body).toMatchObject({ mergeChangeRequests: true, mergeMethods: ['submit'], issues: false });
    const status = await request(app).get('/api/source-control/gerrit/auth/status').query({ instance: ORIGIN }).expect(200);
    expect(status.body).toMatchObject({ connected: true, user: { login: 'alice' } });
    await request(app).post('/api/source-control/gerrit/auth/activate').query({ instance: ORIGIN }).send({ accountId }).expect(200);
    await request(app).get('/api/source-control/gerrit/me').query({ instance: ORIGIN }).expect(410);
    await request(app).post('/api/source-control/gerrit/auth/token').query({ instance: ORIGIN }).send({ token: 'http-pw' }).expect(400);
    // The username rule is the binding presentation's: a C1 control or a colon is refused, an address is not.
    for (const username of ['jane\u0085', 'jane:doe']) {
      await request(app).post('/api/source-control/gerrit/auth/token').query({ instance: ORIGIN }).send({ token: 'http-pw', username }).expect(400);
    }
    const ldap = await request(app).post('/api/source-control/gerrit/auth/token').query({ instance: ORIGIN }).send({ token: 'http-pw', username: 'jane@corp.com' });
    expect(ldap.status, JSON.stringify(ldap.body)).toBe(200);
  });

  it('serves the bound reads', async () => {
    const { app, bound } = await appWith({
      'GET /changes/': (call) => (call.url.searchParams.get('q')?.startsWith('change:') ? fixtures.statusQuery : [fixtures.change]),
      'GET /projects/platform%2Fapp/branches/': fixtures.branches,
    });
    const status = await request(app).get('/api/source-control/gerrit/pr/status').query({ ...bound, branch: 'login' });
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    const list = await request(app).get('/api/source-control/gerrit/pulls/list').query(bound);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const context = await request(app).get('/api/source-control/gerrit/pulls/context').query({ ...bound, number: '42', diff: '1', revision: PS3 });
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body.revisions.length).toBeGreaterThan(0);
    const upstream = await request(app).get('/api/source-control/gerrit/repo/upstream').query(bound);
    expect(upstream.status, JSON.stringify(upstream.body)).toBe(200);
    const branches = await request(app).get('/api/source-control/gerrit/repo/branches').query({ ...bound, owner: 'platform', repo: 'app' });
    expect(branches.status, JSON.stringify(branches.body)).toBe(200);
    const reviewers = await request(app).get('/api/source-control/gerrit/references/reviewers').query({ ...bound, owner: 'platform', repo: 'app' });
    expect(reviewers.status, JSON.stringify(reviewers.body)).toBe(200);
  });

  it('reads status again once the local branch has a new tip, instead of answering the cached one', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-gerrit-tip-'));
    directories.push(repo);
    const git = (...args) => execFileSync('git', args, {
      cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
    });
    git('init', '-q', '-b', 'login');
    git('commit', '--allow-empty', '-q', '-m', 'One');
    const readLocalRevision = vi.fn(async () => ({ sha: PS3, changeId: fixtures.changeId }));
    const { app, bound } = await appWith({ 'GET /changes/': fixtures.statusQuery }, { readLocalRevision });
    const status = async () => {
      const response = await request(app).get('/api/source-control/gerrit/pr/status').query({ ...bound, directory: repo, branch: 'login' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    };

    await status();
    await status();
    expect(readLocalRevision).toHaveBeenCalledTimes(1);
    git('commit', '--allow-empty', '-q', '-m', 'Two');
    await status();
    expect(readLocalRevision).toHaveBeenCalledTimes(2);
  });

  it('performs every mutation route Gerrit offers through the executor', async () => {
    const { app, gerrit } = await appWith({
      [`POST ${CHANGE}/submit`]: { ...fixtures.change, status: 'MERGED' },
      [`POST ${CHANGE}/ready`]: () => new Response('', { status: 200 }),
      [`POST ${CHANGE}/abandon`]: { ...fixtures.change, status: 'ABANDONED' },
      [`POST ${CHANGE}/revisions/current/review`]: fixtures.reviewResult,
      [`POST ${CHANGE}/revisions/${PS3}/review`]: fixtures.reviewResult,
      [`POST ${CHANGE}/reviewers`]: fixtures.reviewerAdded,
      // The change's other reviewer leaves the set.
      [`POST ${CHANGE}/reviewers/1000097/delete`]: {},
    });
    const mutate = async (suffix, body) => {
      const response = await request(app).post(`/api/source-control/gerrit${suffix}`)
        .send({ idempotencyKey: `key-${suffix}`, target, ...body });
      return { status: response.status, body: response.body };
    };
    for (const [suffix, body] of [
      ['/pr/review', { votes: { 'Code-Review': 2 }, body: 'LGTM' }],
      ['/pr/comment', { body: 'A note' }],
      ['/pr/merge', { method: 'submit' }],
      ['/pr/ready', {}],
      ['/pr/state', { state: 'closed' }],
      ['/pr/reviewers', { reviewers: ['1000098'] }],
    ]) {
      const result = await mutate(suffix, body);
      expect(result.status, `${suffix} ${JSON.stringify(result.body)}`).toBe(200);
      expect(result.body.status, suffix).not.toBe('failed');
    }
    expect(gerrit.calls.some((call) => call.method === 'POST' && call.url.pathname.endsWith('/submit'))).toBe(true);
    // A verdict is refused before anything is sent.
    expect((await mutate('/pr/review', { verdict: 'approve' })).status).toBe(400);
    // So is a submit that names no patchset.
    const unnamed = await request(app).post('/api/source-control/gerrit/pr/merge')
      .send({ idempotencyKey: 'key-submit-unnamed', target: { ...target, headSha: undefined }, method: 'submit' });
    expect(unnamed.status, JSON.stringify(unnamed.body)).toBe(400);
  });

  it('takes a top-level project selector (an empty owner), and still refuses an owner without a name', async () => {
    const { app, bound } = await appWith();
    // The shell passes `{ owner: '', name: 'demo' }` on; the provider then
    // answers that this checkout is bound to platform/app, not demo.
    const branches = await request(app).get('/api/source-control/gerrit/repo/branches').query({ ...bound, owner: '', repo: 'demo' });
    expect(branches.body.error).not.toBe('owner and repo are required');
    await request(app).get('/api/source-control/gerrit/repo/branches').query({ ...bound, owner: 'team' }).expect(400);
    await request(app).get('/api/source-control/gerrit/pulls/context').query({ ...bound, number: '42', owner: 'team' }).expect(400);
  });

  it('answers 501 for every capability Gerrit turns off', async () => {
    const { app } = await appWith();
    for (const [method, url] of [
      ['post', '/pr/create'], ['post', '/pr/update'], ['post', '/pr/labels'], ['post', '/issues/comment'], ['post', '/issues/state'],
      ['post', '/issues/labels'], ['get', '/issues/list'], ['get', '/issues/get'], ['get', '/issues/comments'],
      ['post', '/pr/thread/start'], ['post', '/pr/thread/reply'], ['post', '/pr/thread/resolve'], ['get', '/references/labels'],
      ['get', `/uploads/${'0'.repeat(32)}/a.png`], ['get', '/references'], ['post', '/references/across'],
      ['get', '/references/detail'], ['get', '/references/status'], ['post', '/auth/start'], ['post', '/auth/complete'], ['post', '/auth/cli'],
    ]) {
      const response = await request(app)[method](`/api/source-control/gerrit${url}`).query({ instance: ORIGIN }).send({});
      expect(response.status, url).toBe(501);
    }
  });
});
