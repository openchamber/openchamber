import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import { createProviderDescriptors } from '../source-control/provider-descriptors.js';
import { createSourceControlProviders } from '../source-control/provider-registry.js';
import { registerProviderRoutes } from '../source-control/provider-routes.js';
import { registerSourceControlRoutes } from '../source-control/routes.js';
import { giteaDescriptor } from './descriptor.js';
import { fakeGitea, fixtures, forkNetworkRoutes, HEAD, ORIGIN, resolveForkRemote } from './fixtures/fake-fetch.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-gitea-'));
  directories.push(directory);
  return directory;
}

async function setup(routes = forkNetworkRoutes()) {
  const gitea = fakeGitea(routes);
  const authStore = createSourceControlAuthStore({ filePath: path.join(await tempDirectory(), 'source-control-auth.json') });
  const providers = createSourceControlProviders({
    authStore,
    descriptors: createProviderDescriptors([giteaDescriptor]),
    hostServices: { gitea: { fetch: gitea.fetch, resolveRepos: resolveForkRemote } },
  });
  const events = { connected: vi.fn(), invalidated: vi.fn(), removed: vi.fn() };
  providers.events.subscribe(events);
  const impl = await providers.implementation('gitea');
  return { ...gitea, providers, impl, events, store: authStore.section('gitea') };
}

describe('Gitea provider authentication', () => {
  it('connects with a verified personal access token and reports the account', async () => {
    const { impl, events, calls } = await setup();

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).resolves.toMatchObject({ connected: true, user: { id: 1, login: 'alice' } });

    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/v1/user', '/api/v1/version']);
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(events.connected).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ provider: 'gitea', instance: ORIGIN }),
      credential: expect.objectContaining({ providerUserId: `${ORIGIN}#1` }),
    }));
    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'connected', user: { login: 'alice', provider: 'gitea' } });
  });

  it('refuses a Gitea older than 1.21 and stores nothing', async () => {
    const { impl, store } = await setup(forkNetworkRoutes({ 'GET /version': { version: '1.20.6' } }));

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
      sourceControlResponse: { status: 400, body: { code: 'UNSUPPORTED_PROVIDER_VERSION' } },
    });
    expect(await store.listInstances()).toEqual([]);
  });

  it('sends a Forgejo server to the Forgejo card', async () => {
    const forgejo = forkNetworkRoutes({ 'GET /version': { version: '9.0.3+gitea-1.22.0' } });
    const { impl, store } = await setup(forgejo);
    await expect(impl.auth.capabilities({ instance: ORIGIN })).resolves.toMatchObject({
      authentication: true,
      authenticationMethods: { pat: { available: true }, device: { available: false, reason: 'unsupported' }, cli: { available: false, reason: 'unsupported' } },
    });

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
      sourceControlResponse: { status: 409, body: { code: 'SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER', provider: 'forgejo' } },
    });
    expect(await store.listInstances()).toEqual([]);
  });

  describe('an instance that refuses anonymous reads', () => {
    // `[service] REQUIRE_SIGNIN_VIEW = true`: the API answers 403 to any request without a token.
    const locked = (version) => (call) => (call.headers.authorization === 'token pat-1'
      ? { version }
      : new Response(JSON.stringify({ message: 'Only signed in user is allowed to call APIs.' }), { status: 403 }));

    it('offers the token form, then reads the version with the token at connect', async () => {
      const { impl, calls } = await setup(forkNetworkRoutes({ 'GET /version': locked(fixtures.version.version) }));
      await expect(impl.auth.capabilities({ instance: ORIGIN })).resolves.toMatchObject({
        authentication: true,
        authenticationMethods: { pat: { available: true } },
      });
      calls.length = 0;

      await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).resolves.toMatchObject({ connected: true, user: { login: 'alice' } });
      expect(calls.map((call) => [call.url.pathname, call.headers.authorization])).toEqual([
        ['/api/v1/user', 'token pat-1'],
        ['/api/v1/version', undefined],
        ['/api/v1/version', 'token pat-1'],
      ]);
    });

    it('still sends a locked Forgejo to the Forgejo card', async () => {
      const { impl, store } = await setup(forkNetworkRoutes({ 'GET /version': locked('15.0.10+gitea-1.22.0') }));
      await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
        sourceControlResponse: { status: 409, body: { code: 'SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER', provider: 'forgejo' } },
      });
      expect(await store.listInstances()).toEqual([]);
    });
  });

  it('writes an account off when Gitea refuses its token', async () => {
    let refuse = false;
    const { impl, events, store } = await setup(forkNetworkRoutes({
      'GET /user': () => (refuse ? new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 }) : fixtures.user),
    }));
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    refuse = true;

    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'disconnected', connected: false });

    expect(events.invalidated).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gitea', instance: ORIGIN }));
    expect((await store.listAccounts(ORIGIN))[0]).toMatchObject({ status: 'invalid' });
  });

  it('hands Git transport the token with the account login as its username', async () => {
    const { impl, providers } = await setup();
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const accountId = await impl.auth.readCurrentAccountId({ instance: ORIGIN });

    const credential = await providers.readTransportCredential({ provider: 'gitea', instance: ORIGIN, credentialId: accountId, credentialRevision: 1 });

    expect(credential).toMatchObject({ source: 'pat', secret: 'pat-1', user: { login: 'alice' }, providerUserId: `${ORIGIN}#1` });
    expect(giteaDescriptor.transport.httpsUsername).toEqual({ kind: 'login' });
  });

  it('keeps the token out of the session the shell holds', async () => {
    const { impl } = await setup();
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });

    const session = await impl.auth.resolveAccount({ instance: ORIGIN });

    expect(Object.isFrozen(session)).toBe(true);
    expect(JSON.stringify(session)).not.toContain('pat-1');
    expect(session).toMatchObject({ instance: ORIGIN, providerUserId: `${ORIGIN}#1`, secretKind: 'pat' });
  });

  it('owns only hosts of instances it knows', async () => {
    const { impl } = await setup();
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', knownInstances: [ORIGIN] })).toBe(ORIGIN);
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', knownInstances: [] })).toBeNull();
    // Two instances on one host: an HTTPS remote's port picks one, an SSH remote takes the first.
    const twoPorts = [ORIGIN, `${ORIGIN}:3443`];
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', port: 3443, knownInstances: twoPorts })).toBe(`${ORIGIN}:3443`);
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', port: 443, knownInstances: twoPorts })).toBe(ORIGIN);
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', port: 3000, knownInstances: twoPorts })).toBeNull();
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', knownInstances: twoPorts })).toBe(ORIGIN);
  });
});

describe('Gitea mutation input', () => {
  it('refuses a request for changes without a body before anything is sent, as Gitea would', async () => {
    const { impl, calls } = await setup();
    const prepare = (input) => impl.mutations.prepare({
      route: '/pr/review', input, context: { target: { number: 1, headSha: HEAD } }, actor: 'actor', credential: 'credential',
    });

    expect(() => prepare({ verdict: 'request-changes' })).toThrow(expect.objectContaining({ code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400 }));
    expect(() => prepare({ verdict: 'request-changes', body: '  ' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(prepare({ verdict: 'request-changes', body: 'Please fix' }).input).toMatchObject({ verdict: 'request-changes', body: 'Please fix' });
    expect(prepare({ verdict: 'approve' }).input).toMatchObject({ verdict: 'approve', body: undefined });
    expect(fixtures.errors.reviewRequestChangesWithoutBody.status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe('Gitea behind the route shell', () => {
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

  it('invalidates the bound account when a read is refused with 401', async () => {
    let refuse = false;
    const { app, impl, events } = await appWith(forkNetworkRoutes({
      'GET /repos/bob/app': () => (refuse ? new Response('{}', { status: 401 }) : fixtures.forkRepo),
    }));
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const accountId = await impl.auth.readCurrentAccountId({ instance: ORIGIN });
    refuse = true;

    const response = await request(app).get('/api/source-control/gitea/pulls/list')
      .query({ instance: ORIGIN, directory: '/repo', accountId, repositoryId: 'r', bindingRevision: '1', primaryRemote: 'origin' });

    expect(response.status).toBe(401);
    expect(events.invalidated).toHaveBeenCalledWith({ provider: 'gitea', instance: ORIGIN, accountId });
  });

  it('answers 501 for review threads, uploads and the reference picker', async () => {
    const { app } = await appWith();
    for (const [method, url] of [
      ['post', '/api/source-control/gitea/pr/thread/reply'],
      ['post', '/api/source-control/gitea/pr/thread/resolve'],
      ['get', '/api/source-control/gitea/uploads/0123456789abcdef0123456789abcdef/a.png'],
      ['get', '/api/source-control/gitea/references'],
      ['post', '/api/source-control/gitea/auth/start'],
      ['post', '/api/source-control/gitea/auth/cli'],
    ]) {
      const response = await request(app)[method](url);
      expect(response.status, url).toBe(501);
    }
  });
});

describe('Gitea in the registry (smoke)', () => {
  it('is listed third and answers disconnected without an account', async () => {
    const app = express();
    app.use(express.json());
    registerSourceControlRoutes(app, { configRoot: await tempDirectory() });

    const providers = await request(app).get('/api/source-control/providers');
    expect(providers.status).toBe(200);
    expect(providers.body.providers.map((provider) => [provider.id, provider.order])).toEqual([['github', 0], ['gitlab', 1], ['gitea', 2], ['gerrit', 3], ['forgejo', 4]]);

    const status = await request(app).get('/api/source-control/gitea/auth/status').query({ instance: 'https://gitea.example.com' });
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ provider: 'gitea', instance: 'https://gitea.example.com', status: 'disconnected', connected: false, accounts: [] });

    const instances = await request(app).get('/api/source-control/instances');
    expect(instances.body.instances.filter((entry) => entry.provider === 'gitea')).toEqual([]);
  });
});

describe('Gitea contributor source', () => {
  // Git transport reaches a loopback HTTP instance, so its fork is a source too.
  it('takes the fork clone URL of a loopback HTTP instance', async () => {
    const local = 'http://127.0.0.1:3000';
    const { impl } = await setup(JSON.parse(JSON.stringify(forkNetworkRoutes()).replaceAll(ORIGIN, local)));
    await impl.auth.connectToken({ instance: local, token: 'pat-1' });
    const session = await impl.auth.resolveAccount({ instance: local });

    await expect(impl.resources.resolveChangeRequestSource({
      session, context: { directory: '/repo', primaryRemote: 'origin', instance: local },
      project: { id: '1', owner: 'alice', name: 'app' }, number: 1, expectedHeadSha: HEAD, requestedRemoteName: 'pr-bob',
    })).resolves.toMatchObject({ classification: 'contributor-fork', endpoint: `${local}/bob/app.git`, headRef: 'refs/heads/feature' });
  });
});
