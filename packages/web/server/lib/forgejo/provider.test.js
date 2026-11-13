import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { giteaDescriptor } from '../gitea/descriptor.js';
import { fakeGitea } from '../gitea/fixtures/fake-fetch.js';
import { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import { createProviderDescriptors } from '../source-control/provider-descriptors.js';
import { createSourceControlProviders } from '../source-control/provider-registry.js';
import { registerSourceControlRoutes } from '../source-control/routes.js';
import { forgejoDescriptor } from './descriptor.js';
import fixtures from './fixtures/api.json' with { type: 'json' };

const ORIGIN = 'https://forgejo.example.com';
const HEAD = fixtures.forkPull.head.sha;

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-forgejo-'));
  directories.push(directory);
  return directory;
}

/** The recorded network: bob/app (remote `origin`) forked from alice/app, with pull request #1 from bob:feature. */
const forkNetworkRoutes = (extra = {}) => ({
  'GET /user': fixtures.user,
  'GET /version': fixtures.version,
  'GET /repos/bob/app': fixtures.forkRepo,
  'GET /repositories/1': fixtures.upstreamRepo,
  'GET /repos/alice/app': fixtures.upstreamRepo,
  'GET /repos/alice/app/pulls/1': fixtures.forkPull,
  [`GET /repos/alice/app/commits/${HEAD}/status`]: fixtures.combinedStatus,
  ...extra,
});

const resolveForkRemote = async () => ({ repos: [{ owner: 'bob', name: 'app', repoPath: 'bob/app', url: `${ORIGIN}/bob/app`, remoteName: 'origin' }] });

/** Gitea and Forgejo over one auth store and one fake server, as the registry serves them. */
async function setup(routes = forkNetworkRoutes()) {
  const server = fakeGitea(routes);
  const authStore = createSourceControlAuthStore({ filePath: path.join(await tempDirectory(), 'source-control-auth.json') });
  const services = { fetch: server.fetch, resolveRepos: resolveForkRemote };
  const providers = createSourceControlProviders({
    authStore,
    descriptors: createProviderDescriptors([giteaDescriptor, forgejoDescriptor]),
    hostServices: { gitea: services, forgejo: services },
  });
  const events = { connected: vi.fn(), invalidated: vi.fn(), removed: vi.fn() };
  providers.events.subscribe(events);
  return {
    ...server, providers, events, authStore,
    forgejo: await providers.implementation('forgejo'),
    gitea: await providers.implementation('gitea'),
  };
}

const refusal = (provider) => ({
  sourceControlResponse: { status: 409, body: { code: 'SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER', provider } },
});

describe('Forgejo provider authentication', () => {
  it.each([['17.0.0', fixtures.version], ['15.0.10', fixtures.version_15]])('connects to Forgejo %s and keeps the account in its own section', async (_name, version) => {
    const { forgejo, events, authStore } = await setup(forkNetworkRoutes({ 'GET /version': version }));

    await expect(forgejo.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).resolves.toMatchObject({ connected: true, user: { login: 'alice' } });

    expect(events.connected).toHaveBeenCalledWith(expect.objectContaining({ account: expect.objectContaining({ provider: 'forgejo', instance: ORIGIN }) }));
    expect(await authStore.section('forgejo').listInstances()).toEqual([ORIGIN]);
    expect(await authStore.section('gitea').listInstances()).toEqual([]);
    await expect(forgejo.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'connected', user: { provider: 'forgejo' } });
  });

  it('sends a Gitea server to the Gitea card and stores nothing', async () => {
    const { forgejo, authStore } = await setup(forkNetworkRoutes({ 'GET /version': { version: '1.27.3' } }));

    await expect(forgejo.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject(refusal('gitea'));
    expect(await authStore.section('forgejo').listInstances()).toEqual([]);
  });

  it('refuses a Forgejo older than 7.0 in its own numbering', async () => {
    const { forgejo } = await setup(forkNetworkRoutes({ 'GET /version': { version: '6.0.14+gitea-1.20.5' } }));

    await expect(forgejo.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
      sourceControlResponse: { status: 400, body: { code: 'UNSUPPORTED_PROVIDER_VERSION', error: 'Forgejo 6.0.14+gitea-1.20.5 is older than OpenChamber supports (7.0)' } },
    });
  });
});

describe('Forgejo reads', () => {
  it('answers a branch status as Forgejo from the recorded fork pull request', async () => {
    const { forgejo } = await setup(forkNetworkRoutes({
      // The fork has none of its own; the upstream answers the direct lookup.
      'GET /repos/bob/app/pulls': [],
      'GET /repos/alice/app/pulls/main/bob:feature': fixtures.forkPull,
    }));
    await forgejo.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const session = await forgejo.auth.resolveAccount({ instance: ORIGIN });

    const status = await forgejo.resources.changeRequestStatus({ session, directory: '/repo', branch: 'feature', remote: 'origin' });

    expect(status).toMatchObject({
      identity: { provider: 'forgejo', instance: ORIGIN },
      project: { provider: 'forgejo', owner: 'alice', name: 'app' },
      changeRequest: { provider: 'forgejo', number: 1, state: 'open', headLabel: 'bob:feature', headSha: HEAD },
      ci: { summary: { state: 'success' } },
    });
  });

  it('names Forgejo in the errors a person reads', async () => {
    const { forgejo } = await setup(forkNetworkRoutes({
      'GET /repos/alice/app/pulls/9': new Response(fixtures.errors.baseHeadNotFound.body, { status: 404 }),
      'GET /repos/bob/app/pulls/9': new Response(fixtures.errors.baseHeadNotFound.body, { status: 404 }),
    }));
    await forgejo.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const session = await forgejo.auth.resolveAccount({ instance: ORIGIN });

    await expect(forgejo.resources.readChangeRequestHead({ session, directory: '/repo', remote: 'origin', number: 9 }))
      .rejects.toMatchObject({ status: 404, message: 'Forgejo pull request #9 was not found' });
  });
});

describe('Forgejo in the registry (smoke)', () => {
  it('is listed last, offers Codeberg without an account and answers disconnected', async () => {
    const app = express();
    app.use(express.json());
    registerSourceControlRoutes(app, { configRoot: await tempDirectory() });

    const providers = await request(app).get('/api/source-control/providers');
    expect(providers.body.providers.map((provider) => provider.id)).toEqual(['github', 'gitlab', 'gitea', 'gerrit', 'forgejo']);
    expect(providers.body.providers.at(-1)).toMatchObject({
      id: 'forgejo', label: 'Forgejo', order: 4,
      instances: { defaultInstance: 'https://codeberg.org', multiple: true },
      auth: { methods: ['pat'], token: { scopes: ['write:repository', 'write:issue', 'read:user'], createPath: '/user/settings/applications' } },
    });

    const instances = await request(app).get('/api/source-control/instances');
    expect(instances.body.instances.filter((entry) => entry.provider === 'forgejo')).toEqual([{ provider: 'forgejo', instance: 'https://codeberg.org' }]);

    const status = await request(app).get('/api/source-control/forgejo/auth/status').query({ instance: 'https://codeberg.org' });
    expect(status.body).toEqual({ provider: 'forgejo', instance: 'https://codeberg.org', status: 'disconnected', connected: false, accounts: [] });

    const thread = await request(app).post('/api/source-control/forgejo/pr/thread/reply');
    expect(thread.status).toBe(501);
  });
});
