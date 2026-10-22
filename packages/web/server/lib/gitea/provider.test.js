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
import { fakeGitea, fixtures, forkNetworkRoutes, ORIGIN, resolveForkRemote } from './fixtures/fake-fetch.js';

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

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).resolves.toMatchObject({ connected: true, user: { id: 7, login: 'alice' } });

    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/v1/user', '/api/v1/version']);
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(events.connected).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ provider: 'gitea', instance: ORIGIN }),
      credential: expect.objectContaining({ providerUserId: `${ORIGIN}#7` }),
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

  it('accepts Forgejo by the Gitea version it reports', async () => {
    const { impl } = await setup(forkNetworkRoutes({ 'GET /version': { version: '9.0.3+gitea-1.22.0' } }));
    await expect(impl.auth.capabilities({ instance: ORIGIN })).resolves.toMatchObject({
      authentication: true,
      authenticationMethods: { pat: { available: true }, device: { available: false, reason: 'unsupported' }, cli: { available: false, reason: 'unsupported' } },
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

    expect(credential).toMatchObject({ source: 'pat', secret: 'pat-1', user: { login: 'alice' }, providerUserId: `${ORIGIN}#7` });
    expect(giteaDescriptor.transport.httpsUsername).toEqual({ kind: 'login' });
  });

  it('keeps the token out of the session the shell holds', async () => {
    const { impl } = await setup();
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });

    const session = await impl.auth.resolveAccount({ instance: ORIGIN });

    expect(Object.isFrozen(session)).toBe(true);
    expect(JSON.stringify(session)).not.toContain('pat-1');
    expect(session).toMatchObject({ instance: ORIGIN, providerUserId: `${ORIGIN}#7`, secretKind: 'pat' });
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
      'GET /repos/alice/app': () => (refuse ? new Response('{}', { status: 401 }) : fixtures.forkRepo),
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
    expect(providers.body.providers.map((provider) => [provider.id, provider.order])).toEqual([['github', 0], ['gitlab', 1], ['gitea', 2]]);

    const status = await request(app).get('/api/source-control/gitea/auth/status').query({ instance: 'https://gitea.example.com' });
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ provider: 'gitea', instance: 'https://gitea.example.com', status: 'disconnected', connected: false, accounts: [] });

    const instances = await request(app).get('/api/source-control/instances');
    expect(instances.body.instances.filter((entry) => entry.provider === 'gitea')).toEqual([]);
  });
});
