import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import { createProviderDescriptors, publicProviderDescriptor } from '../source-control/provider-descriptors.js';
import { createSourceControlProviders } from '../source-control/provider-registry.js';
import { registerProviderRoutes } from '../source-control/provider-routes.js';
import { gerritDescriptor } from './descriptor.js';
import {
  CHANGE, changeRoutes, fakeGerrit, fixtures, ORIGIN, PS2, PS3, replay, resolvePlatformApp,
} from './fixtures/fake-fetch.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-gerrit-'));
  directories.push(directory);
  return directory;
}

async function setup(routes = {}) {
  const gerrit = fakeGerrit(changeRoutes(routes));
  const authStore = createSourceControlAuthStore({ filePath: path.join(await tempDirectory(), 'source-control-auth.json') });
  const providers = createSourceControlProviders({
    authStore,
    descriptors: createProviderDescriptors([gerritDescriptor]),
    loaders: { gerrit: () => import('./provider.js') },
    hostServices: {
      gerrit: {
        fetch: gerrit.fetch,
        resolveProjects: resolvePlatformApp,
        readLocalRevision: async () => ({ sha: PS3, changeId: fixtures.changeId }),
        readUpstreamBranch: async () => 'master',
      },
    },
  });
  const events = { connected: vi.fn(), invalidated: vi.fn(), removed: vi.fn() };
  providers.events.subscribe(events);
  const impl = await providers.implementation('gerrit');
  return { ...gerrit, providers, impl, events, store: authStore.section('gerrit') };
}

const connect = async (impl) => {
  await impl.auth.connectToken({ instance: ORIGIN, token: 'http-pw', username: 'alice' });
  return impl.auth.resolveAccount({ instance: ORIGIN });
};

describe('Gerrit descriptor', () => {
  it('binds an HTTP(S) remote without its /a/ prefix, and keeps SSH paths as they are', () => {
    const pathOf = gerritDescriptor.projectPathOfRemote;
    expect(pathOf({ protocol: 'https', path: 'a/demo' })).toBe('demo');
    expect(pathOf({ protocol: 'http', path: 'a/team/app/sub.git' })).toBe('team/app/sub');
    expect(pathOf({ protocol: 'https', path: 'platform/app.git' })).toBe('platform/app');
    expect(pathOf({ protocol: 'ssh', path: 'a/demo.git' })).toBe('a/demo');
    expect(pathOf({ protocol: 'ssh', path: 'demo' })).toBe('demo');
  });

  it('publishes a change host: votes, revisions, push to create, submit alone', () => {
    const published = publicProviderDescriptor(gerritDescriptor, 3);
    expect(published.terminology).toEqual({
      changeRequest: 'change', changeRequestPrefix: '#', issuePrefix: '#', sharedNumberSpace: true, abbreviation: 'CL', promptNoun: 'change', ci: 'checks',
    });
    expect(published.features).toMatchObject({ reviewModel: 'votes', revisions: true, createByPush: true, branchHeads: false, submitRequirements: true });
    expect(published.settings.fields).toEqual([
      { id: 'instance', kind: 'instance-url', secret: false },
      { id: 'username', kind: 'username', secret: false },
      { id: 'token', kind: 'http-password', secret: true },
    ]);
    expect(published.auth).toMatchObject({ methods: ['pat'], token: { scopes: [], createPath: '/settings/#HTTPCredentials' } });
    expect(published.urls.changeRequest).toEqual(['/c/{project+}/+/{number}']);
    expect(gerritDescriptor.repositoryPath).toBe('path');
    expect(gerritDescriptor.capabilities.merge).toEqual({ methods: ['submit'] });
    expect(gerritDescriptor.transport).toEqual({ httpsUsername: { kind: 'login' }, managedHttpsInstances: 'any', appendDotGitToHttpsClone: false });
    expect(gerritDescriptor.urls.thread.pattern.exec('/c/platform/app/+/42/3')?.[1]).toBe('/c/platform/app/+/42');
  });
});

describe('Gerrit authentication', () => {
  it('connects with a username and HTTP password, checking the version, and stores the username as the login', async () => {
    const { impl, events, calls } = await setup();

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'http-pw', username: 'alice' })).resolves.toMatchObject({
      connected: true, user: { id: 1000096, login: 'alice' },
    });

    expect(calls.map((call) => [call.url.pathname, call.authenticated])).toEqual([['/a/accounts/self', true], ['/config/server/version', false]]);
    expect(events.connected).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ provider: 'gerrit', instance: ORIGIN }),
      credential: expect.objectContaining({ providerUserId: `${ORIGIN}#1000096` }),
    }));
    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'connected', user: { login: 'alice', provider: 'gerrit' } });
  });

  it('refuses a Gerrit older than 3.8 and stores nothing', async () => {
    const { impl, store } = await setup({ 'GET /config/server/version': '3.7.4' });
    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'http-pw', username: 'alice' })).rejects.toMatchObject({
      sourceControlResponse: { status: 400, body: { code: 'UNSUPPORTED_PROVIDER_VERSION' } },
    });
    expect(await store.listInstances()).toEqual([]);
  });

  it('writes an account off when Gerrit refuses its password', async () => {
    let refuse = false;
    const { impl, events, store } = await setup({
      'GET /accounts/self': () => (refuse ? replay(fixtures.errors.unauthorized) : fixtures.accountSelf),
    });
    await impl.auth.connectToken({ instance: ORIGIN, token: 'http-pw', username: 'alice' });
    refuse = true;

    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'disconnected', connected: false });
    expect(events.invalidated).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gerrit', instance: ORIGIN }));
    expect((await store.listAccounts(ORIGIN))[0]).toMatchObject({ status: 'invalid' });
  });

  it('hands Git transport the HTTP password with the Gerrit username, and keeps both out of the session', async () => {
    const { impl, providers } = await setup();
    const session = await connect(impl);

    const credential = await providers.readTransportCredential({ provider: 'gerrit', instance: ORIGIN, credentialId: session.accountId, credentialRevision: 1 });

    expect(credential).toMatchObject({ source: 'pat', secret: 'http-pw', user: { login: 'alice' }, providerUserId: `${ORIGIN}#1000096` });
    expect(Object.isFrozen(session)).toBe(true);
    expect(JSON.stringify(session)).not.toContain('http-pw');
  });

  it('reads with Basic auth built from the stored login', async () => {
    const { impl, calls } = await setup({ 'GET /changes/': fixtures.statusQuery });
    const session = await connect(impl);

    await impl.resources.changeRequestStatus({ session, directory: '/repo', branch: 'login', remote: 'origin', force: false });

    const query = calls.find((call) => call.url.pathname === '/a/changes/');
    expect(query.headers.authorization).toBe(`Basic ${Buffer.from('alice:http-pw').toString('base64')}`);
  });
});

describe('Gerrit mutations', () => {
  const context = {
    repositoryId: 'repo-1', bindingRevision: 2, primaryRemote: 'origin', directory: '/repo',
    target: { project: { owner: 'platform', name: 'app' }, number: 42, headSha: PS3 },
  };
  const actor = { provider: 'gerrit', instance: ORIGIN, accountId: 'acct-1' };
  const credential = { accountId: 'acct-1', credentialRevision: 1 };
  const frozenTarget = {
    repositoryId: 'repo-1', bindingRevision: 2, primaryRemote: 'origin', project: { id: 'platform/app', owner: 'platform', name: 'app' },
    number: 42, head: 'refs/changes/42/42/3', base: 'master', headSha: PS3,
  };

  async function run(impl, session, route, input) {
    const prepared = impl.mutations.prepare({ route, input, context, actor, credential });
    const resolved = await impl.mutations.resolveTarget({ session, context, kind: prepared.kind, input: prepared.input });
    const args = { session, route, kind: prepared.kind, input: prepared.input, resolved };
    return { prepared, resolved, perform: () => impl.mutations.perform(args), reconcile: () => impl.mutations.reconcile(args) };
  }

  it('performs the change routes only; create is pushed, not posted', async () => {
    const { impl } = await setup();
    expect(impl.mutations.routes).toEqual(['/pr/merge', '/pr/ready', '/pr/review', '/pr/comment', '/pr/state', '/pr/reviewers']);
    expect(() => impl.mutations.prepare({ route: '/pr/create', input: { title: 'x' }, context, actor, credential })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('keeps the submit and votes digests byte-identical', async () => {
    const { impl } = await setup();
    // The literals were frozen over this patchset SHA; the recorded fixtures carry other SHAs.
    const digestTarget = { ...frozenTarget, headSha: '3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f' };
    const digest = (route, input) => impl.mutations.prepare({ route, input, context, actor, credential }).digest(digestTarget);
    expect(digest('/pr/merge', { method: 'submit' })).toBe('4473b7f7a3d939ced0c85bca30e6bce3e8f289bbd621a9ddb1e2337da643b1f1');
    expect(digest('/pr/review', { votes: { 'Code-Review': 2, Verified: 1 }, body: 'LGTM' })).toBe('4fd47905b510db66309e7539296b6e4d8781a12f726f940af841adfeeaeddb0e');
    expect(digest('/pr/review', { votes: { Verified: 1, 'Code-Review': 2 }, body: 'LGTM' })).toBe('4fd47905b510db66309e7539296b6e4d8781a12f726f940af841adfeeaeddb0e');
    expect(digest('/pr/review', { votes: { 'Code-Review': -1 } })).toBe('dda0eb5b26714cde0f71362205281948a83a5dff6f07851dfdcea1ee83a2c1f3');
  });

  it('refuses a verdict: Gerrit reviews are votes', async () => {
    const { impl } = await setup();
    expect(() => impl.mutations.prepare({ route: '/pr/review', input: { verdict: 'approve' }, context, actor, credential }))
      .toThrow(expect.objectContaining({ status: 400 }));
  });

  it('submits and reconciles by MERGED', async () => {
    let status = 'NEW';
    const { impl, calls } = await setup({
      [`GET ${CHANGE}`]: () => ({ ...fixtures.change, status }),
      [`POST ${CHANGE}/submit`]: () => { status = 'MERGED'; return { ...fixtures.change, status }; },
    });
    const session = await connect(impl);
    const mutation = await run(impl, session, '/pr/merge', { method: 'submit' });

    expect(mutation.prepared.kind).toBe('change-request-merge');
    expect(mutation.resolved.target).toEqual(frozenTarget);
    await expect(mutation.perform()).resolves.toEqual({ merged: true });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: {} });
    await expect(mutation.reconcile()).resolves.toEqual({ state: 'succeeded', result: { merged: true } });
  });

  it('votes on the reviewed patchset and leaves the outcome unknown on restart', async () => {
    const { impl, calls } = await setup({ [`POST ${CHANGE}/revisions/${PS3}/review`]: fixtures.reviewResult });
    const session = await connect(impl);
    const mutation = await run(impl, session, '/pr/review', { votes: { 'Code-Review': 2 } });

    await expect(mutation.perform()).resolves.toEqual({ commented: false });
    expect(calls.at(-1).body).toEqual({ labels: { 'Code-Review': 2 } });
    expect(await mutation.reconcile()).toEqual({ state: 'outcome-unknown' });
  });

  it('refuses votes once a newer patchset was uploaded', async () => {
    const { impl } = await setup();
    const session = await connect(impl);
    const prepared = impl.mutations.prepare({ route: '/pr/review', input: { votes: { 'Code-Review': 2 } }, context: { ...context, target: { ...context.target, headSha: PS2 } }, actor, credential });
    await expect(impl.mutations.resolveTarget({ session, context: { ...context, target: { ...context.target, headSha: PS2 } }, kind: prepared.kind, input: prepared.input }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH' });
  });

  it('comments as a review with a message only', async () => {
    const { impl, calls } = await setup({ [`POST ${CHANGE}/revisions/current/review`]: {} });
    const session = await connect(impl);
    const mutation = await run(impl, session, '/pr/comment', { body: 'Thanks' });
    await expect(mutation.perform()).resolves.toEqual({});
    expect(calls.at(-1).body).toEqual({ message: 'Thanks' });
    expect(await mutation.reconcile()).toEqual({ state: 'outcome-unknown' });
  });

  it('marks a work-in-progress change ready and reconciles by the flag', async () => {
    let wip = true;
    const { impl, calls } = await setup({
      [`GET ${CHANGE}`]: () => ({ ...fixtures.change, work_in_progress: wip || undefined }),
      [`POST ${CHANGE}/ready`]: () => { wip = false; return new Response(null, { status: 200 }); },
    });
    const session = await connect(impl);
    const mutation = await run(impl, session, '/pr/ready', {});
    await expect(mutation.perform()).resolves.toEqual({ ready: true });
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.url.pathname)).toEqual([`/a${CHANGE}/ready`]);
    await expect(mutation.reconcile()).resolves.toEqual({ state: 'succeeded', result: { ready: true } });
  });

  it('abandons for closed and restores for open', async () => {
    let status = 'NEW';
    const { impl } = await setup({
      [`GET ${CHANGE}`]: () => ({ ...fixtures.change, status }),
      [`POST ${CHANGE}/abandon`]: () => { status = 'ABANDONED'; return { ...fixtures.change, status }; },
      [`POST ${CHANGE}/restore`]: () => { status = 'NEW'; return { ...fixtures.change, status }; },
    });
    const session = await connect(impl);
    const close = await run(impl, session, '/pr/state', { state: 'closed' });
    await expect(close.perform()).resolves.toEqual({ state: 'closed' });
    await expect(close.reconcile()).resolves.toEqual({ state: 'succeeded', result: { state: 'closed' } });
    const reopen = await run(impl, session, '/pr/state', { state: 'open' });
    await expect(reopen.perform()).resolves.toEqual({ state: 'open' });
  });

  it('sets reviewers by account id and reconciles only a matching set', async () => {
    let reviewers = fixtures.change.reviewers.REVIEWER;
    const { impl } = await setup({
      [`GET ${CHANGE}`]: () => ({ ...fixtures.change, reviewers: { REVIEWER: reviewers } }),
      [`POST ${CHANGE}/reviewers`]: fixtures.reviewerAdded,
      [`POST ${CHANGE}/reviewers/1000097/delete`]: () => { reviewers = reviewers.filter((account) => account._account_id !== 1000097); return new Response(null, { status: 204 }); },
    });
    const session = await connect(impl);
    const mutation = await run(impl, session, '/pr/reviewers', { reviewers: ['1000098'] });
    await expect(mutation.perform()).resolves.toEqual({});
    await expect(mutation.reconcile()).resolves.toEqual({ state: 'succeeded', result: {} });
  });

  it('rebuilds a replayed target from the stored one without reading Gerrit', async () => {
    const { impl, calls } = await setup();
    const session = await connect(impl);
    const sent = calls.length;
    expect(await impl.mutations.resolveTarget({ session, context, kind: 'change-request-merge', input: {}, replayOf: { target: frozenTarget } }))
      .toEqual({ providerTarget: { project: 'platform/app', number: 42 }, target: frozenTarget });
    expect(calls).toHaveLength(sent);
  });
});

describe('Gerrit worktree source', () => {
  it('answers a change as its patchset ref in the same project, on a branch named after it', async () => {
    const { impl } = await setup();
    const session = await connect(impl);

    const head = await impl.resources.readChangeRequestHead({ session, directory: '/repo', remote: 'origin', number: 42 });
    expect(head).toEqual({ project: { id: 'platform/app', owner: 'platform', name: 'app' }, headSha: PS3, headBranch: 'change-42', headOwner: 'platform' });

    const source = await impl.resources.resolveChangeRequestSource({
      session, context: { directory: '/repo', primaryRemote: 'origin', instance: ORIGIN }, project: head.project, number: 42, expectedHeadSha: PS3, requestedRemoteName: 'gerrit',
    });
    expect(source).toMatchObject({
      classification: 'same-repository', headRef: 'refs/changes/42/42/3', headSha: PS3, endpoint: `${ORIGIN}/a/platform/app`,
      sourceProject: head.project, targetProject: head.project, requestedRemoteName: 'gerrit',
    });
    await expect(impl.resources.resolveChangeRequestSource({
      session, context: { directory: '/repo', primaryRemote: 'origin', instance: ORIGIN }, project: head.project, number: 42, expectedHeadSha: PS2, requestedRemoteName: 'gerrit',
    })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', status: 409 });
  });
});

describe('Gerrit behind the route shell', () => {
  async function appWith(routes) {
    const context = await setup(routes);
    const app = express();
    app.use(express.json());
    registerProviderRoutes(app, {
      providers: context.providers,
      validateReadContext: async (read) => ({ ...read, primaryRemote: 'origin' }),
    });
    return { ...context, app };
  }

  it('connects through /auth/token with the username', async () => {
    const { app } = await appWith();
    const response = await request(app).post('/api/source-control/gerrit/auth/token').query({ instance: ORIGIN }).send({ token: 'http-pw', username: 'alice' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ connected: true, user: { login: 'alice' } });
  });

  it('reads a context at a named revision through the shell', async () => {
    const { app, impl } = await appWith({
      [`GET ${CHANGE}/revisions/${PS2}/files/`]: { 'src/login.js': { lines_inserted: 1 } },
      [`GET ${CHANGE}/revisions/${PS2}/patch`]: () => new Response(fixtures.patch),
    });
    const session = await connect(impl);
    const response = await request(app).get('/api/source-control/gerrit/pulls/context')
      .query({ instance: ORIGIN, directory: '/repo', accountId: session.accountId, repositoryId: 'r', bindingRevision: '1', primaryRemote: 'origin', number: '42', diff: '1', revision: PS2 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.files.map((file) => file.path)).toEqual(['src/login.js']);
    expect(response.body.revisions).toHaveLength(3);
  });

  it('answers 501 for create, issues, labels, threads, uploads and the reference picker', async () => {
    const { app } = await appWith();
    for (const [method, url] of [
      ['post', '/api/source-control/gerrit/pr/create'],
      ['post', '/api/source-control/gerrit/pr/labels'],
      ['post', '/api/source-control/gerrit/issues/comment'],
      ['get', '/api/source-control/gerrit/issues/list'],
      ['post', '/api/source-control/gerrit/pr/thread/reply'],
      ['get', '/api/source-control/gerrit/uploads/0123456789abcdef0123456789abcdef/a.png'],
      ['get', '/api/source-control/gerrit/references'],
      ['post', '/api/source-control/gerrit/auth/start'],
    ]) {
      const response = await request(app)[method](url);
      expect(response.status, url).toBe(501);
    }
  });
});
