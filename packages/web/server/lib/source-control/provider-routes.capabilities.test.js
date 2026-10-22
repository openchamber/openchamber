import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerProviderRoutes } from './provider-routes.js';
import { registerSourceControlRoutes } from './routes.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { createSourceControlProviders } from './provider-registry.js';
import { gitlabDescriptor } from '../gitlab/descriptor.js';

/**
 * A provider that turns capabilities off still answers every route the shell
 * knows, with a stable 501; an unknown provider or path under the module's
 * prefix answers the 404 catch-all. Neither ever reaches the OpenCode proxy.
 */
const acme = Object.freeze({
  ...gitlabDescriptor,
  id: 'acme',
  label: 'Acme',
  instance: { ...gitlabDescriptor.instance, defaultInstances: [] },
  authMethods: { device: false, pat: true, cli: false },
  capabilities: {
    ...gitlabDescriptor.capabilities,
    merge: false,
    labels: false,
    reviewThreads: { start: false, reply: false, resolve: false },
    uploads: false,
  },
});
const instance = 'https://acme.example.com';

const fakeImplementation = () => ({
  classifyFailure: () => 'provider-error',
  auth: {
    capabilities: vi.fn(async () => ({ authentication: true, authenticationMethods: { pat: { available: true } } })),
    status: vi.fn(async ({ instance: origin }) => ({ provider: 'acme', instance: origin, status: 'disconnected', connected: false, accounts: [] })),
    listInstances: vi.fn(async () => [instance]),
    listConnectedAccounts: vi.fn(async () => []),
    resolveAccount: vi.fn(),
  },
  resources: {},
  mutations: { routes: ['/pr/create'], prepare: vi.fn() },
});

const appWith = () => {
  const impl = fakeImplementation();
  const providers = createSourceControlProviders({
    descriptors: createProviderDescriptors([acme]),
    loaders: { acme: async () => ({ createProvider: () => impl }) },
  });
  const proxy = vi.fn((_req, res) => res.status(599).end());
  const app = express();
  app.use(express.json());
  registerSourceControlRoutes(app, {
    providers,
    bindingService: { validateReadContext: vi.fn(), validateMutationContext: vi.fn(), accountUnavailable: vi.fn(), accountConnected: vi.fn() },
    identityProvisioning: { backfillAccountIdentities: vi.fn(), ensureAccountIdentity: vi.fn(), repointAccountIdentities: vi.fn() },
    mutationExecutor: { read: vi.fn(), execute: vi.fn() },
  });
  // Stands in for the OpenCode proxy registered after every OpenChamber route.
  app.use('/api', proxy);
  return { app, impl, proxy };
};

describe('provider route capabilities', () => {
  it.each([
    ['post', '/api/source-control/acme/pr/merge'],
    ['post', '/api/source-control/acme/pr/thread/reply'],
    ['post', '/api/source-control/acme/issues/labels'],
    ['get', '/api/source-control/acme/references/labels'],
    ['get', `/api/source-control/acme/uploads/${'a'.repeat(32)}/picture.png`],
  ])('answers %s %s with a stable 501 when the descriptor turns the capability off', async (method, path) => {
    const { app, proxy } = appWith();
    const response = await request(app)[method](path).query({ instance }).send({}).expect(501);
    expect(response.body.code).toBe('SOURCE_CONTROL_CAPABILITY_UNSUPPORTED');
    expect(proxy).not.toHaveBeenCalled();
  });

  it('answers 501 for a capability the descriptor offers but the implementation lacks', async () => {
    const { app, proxy } = appWith();
    // The descriptor offers comments; this implementation has no route for them.
    const response = await request(app).post('/api/source-control/acme/pr/comment').send({}).expect(501);
    expect(response.body.code).toBe('SOURCE_CONTROL_CAPABILITY_UNSUPPORTED');
    // Device flow is off in the descriptor.
    await request(app).post('/api/source-control/acme/auth/start').query({ instance }).expect(501);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('merges static capabilities with what the instance answers', async () => {
    const { app, impl } = appWith();
    const response = await request(app).get('/api/source-control/acme/capabilities').query({ instance }).expect(200);
    expect(response.body).toMatchObject({
      identity: { provider: 'acme', instance },
      authentication: true,
      mergeChangeRequests: false,
      mergeMethods: [],
      issues: true,
    });
    expect(impl.auth.capabilities).toHaveBeenCalledWith({ instance });
  });

  it('answers 404 for an unknown provider or path instead of reaching the proxy', async () => {
    const { app, proxy } = appWith();
    for (const path of ['/api/source-control/forgejo/pr/status', '/api/source-control/acme/not-a-route', '/api/source-control/github/auth/status']) {
      const response = await request(app).get(path).expect(404);
      expect(response.body.code).toBe('SOURCE_CONTROL_PROVIDER_UNAVAILABLE');
    }
    await request(app).post('/api/source-control/forgejo/pr/create').send({}).expect(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('lists the registered providers and their instances', async () => {
    const { app } = appWith();
    const providers = await request(app).get('/api/source-control/providers').expect(200);
    expect(providers.body.providers).toEqual([expect.objectContaining({ id: 'acme', label: 'Acme', order: 0 })]);
    expect(providers.body.providers[0].auth.methods).toEqual(['pat']);
    const instances = await request(app).get('/api/source-control/instances').expect(200);
    expect(instances.body).toEqual({ instances: [{ provider: 'acme', instance }] });
  });

  it('refuses a source resolution for a provider the registry does not hold', async () => {
    const providers = createSourceControlProviders({ descriptors: createProviderDescriptors([acme]), loaders: {} });
    const shell = registerProviderRoutes({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }, { providers });
    await expect(shell.resolveChangeRequestSource({ context: { provider: 'forgejo' } }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400 });
  });
});

/**
 * Change-host extensions on the shell: a revision on reads only where the
 * descriptor keeps revisions, the username a Basic-auth host signs in with,
 * and `submit` among the merge methods.
 */
describe('provider routes for change hosts', () => {
  const REVISION = 'c'.repeat(40);
  const changeHost = Object.freeze({
    ...acme,
    id: 'review',
    capabilities: { ...acme.capabilities, merge: { methods: ['submit'] }, revisions: true, reviewModel: 'votes', createVia: 'push' },
    settings: [
      { key: 'instance', type: 'instance-url', secret: false, scope: 'instance' },
      { key: 'username', type: 'username', secret: false, scope: 'instance' },
      { key: 'token', type: 'http-password', secret: true, scope: 'instance' },
    ],
  });
  const routesWith = (descriptor) => {
    const impl = {
      ...fakeImplementation(),
      auth: {
        ...fakeImplementation().auth,
        connectToken: vi.fn(async () => ({ connected: true })),
        resolveAccount: vi.fn(async () => ({ instance, accountId: 'account' })),
      },
      resources: {
        changeRequestContext: vi.fn(async () => ({ ok: true })),
        readChangeRequestPatch: vi.fn(async () => ({ patch: '', meta: {} })),
      },
    };
    const providers = createSourceControlProviders({
      descriptors: createProviderDescriptors([descriptor]),
      loaders: { [descriptor.id]: async () => ({ createProvider: () => impl }) },
    });
    const app = express();
    app.use(express.json());
    const context = { provider: descriptor.id, instance, accountId: 'account', directory: '/repo', primaryRemote: 'origin' };
    const validateReadContext = vi.fn(async () => context);
    const shell = registerProviderRoutes(app, { providers, validateReadContext });
    return { app, impl, shell, context, validateReadContext };
  };
  const contextQuery = (extra) => ({ instance, directory: '/repo', number: '5', ...extra });

  it('refuses a revision on a provider without revisions, before any context or account work', async () => {
    const { app, impl, shell, context, validateReadContext } = routesWith(acme);
    const response = await request(app).get('/api/source-control/acme/pulls/context').query(contextQuery({ revision: REVISION })).expect(400);
    expect(response.body.code).toBe('INVALID_SOURCE_CONTROL_READ_CONTEXT');
    expect(validateReadContext).not.toHaveBeenCalled();
    await expect(shell.readChangeRequestPatch({ context: { ...context, provider: 'acme' }, number: 5, revision: REVISION }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400 });
    expect(impl.resources.readChangeRequestPatch).not.toHaveBeenCalled();
  });

  it('reads as before without a revision, never passing the field', async () => {
    const { app, impl, shell, context } = routesWith(acme);
    await request(app).get('/api/source-control/acme/pulls/context').query(contextQuery()).expect(200);
    expect(impl.resources.changeRequestContext.mock.calls[0][0]).not.toHaveProperty('revision');
    await shell.readChangeRequestPatch({ context: { ...context, provider: 'acme' }, number: 5 });
    expect(impl.resources.readChangeRequestPatch.mock.calls[0][0]).not.toHaveProperty('revision');
  });

  it('passes a named revision to a provider that keeps revisions, and refuses a malformed one', async () => {
    const { app, impl, shell, context } = routesWith(changeHost);
    await request(app).get('/api/source-control/review/pulls/context').query(contextQuery({ revision: REVISION.toUpperCase() })).expect(200);
    expect(impl.resources.changeRequestContext).toHaveBeenCalledWith(expect.objectContaining({ number: 5, revision: REVISION }));
    await shell.readChangeRequestPatch({ context, number: 5, revision: REVISION });
    expect(impl.resources.readChangeRequestPatch).toHaveBeenCalledWith(expect.objectContaining({ number: 5, revision: REVISION }));
    const malformed = await request(app).get('/api/source-control/review/pulls/context').query(contextQuery({ revision: 'abc' })).expect(400);
    expect(malformed.body.code).toBe('INVALID_SOURCE_CONTROL_READ_CONTEXT');
  });

  it('passes the username through to a provider whose settings declare one', async () => {
    const { app, impl } = routesWith(changeHost);
    await request(app).post('/api/source-control/review/auth/token').query({ instance }).send({ token: 'pass', username: ' alice ' }).expect(200);
    expect(impl.auth.connectToken).toHaveBeenCalledWith({ instance, token: 'pass', username: 'alice' });
    await request(app).post('/api/source-control/review/auth/token').query({ instance }).send({ token: 'pass' }).expect(400);
    await request(app).post('/api/source-control/review/auth/token').query({ instance }).send({ token: 'pass', username: 'a:b' }).expect(400);
    expect(impl.auth.connectToken).toHaveBeenCalledTimes(1);
  });

  it('never passes a username to a token-only provider', async () => {
    const { app, impl } = routesWith(acme);
    await request(app).post('/api/source-control/acme/auth/token').query({ instance }).send({ token: 'pat', username: 'alice' }).expect(200);
    expect(impl.auth.connectToken).toHaveBeenCalledWith({ instance, token: 'pat' });
  });

  it('answers JSON, not a crash page, when a read fails with a numeric (process exit) code', async () => {
    const { app, impl } = routesWith(changeHost);
    impl.resources.changeRequestStatus = vi.fn(async () => { throw Object.assign(new Error('git exited 128'), { code: 128 }); });
    const failed = await request(app).get('/api/source-control/review/pr/status').query({ instance, directory: '/repo', branch: 'nope' });
    expect(failed.status).toBe(500);
    expect(failed.type).toBe('application/json');
    impl.resources.changeRequestStatus = vi.fn(async () => { throw Object.assign(new Error('Branch nope does not exist'), { code: 'GIT_BRANCH_NOT_FOUND', status: 404 }); });
    const missing = await request(app).get('/api/source-control/review/pr/status').query({ instance, directory: '/repo', branch: 'nope', force: '1' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Branch nope does not exist' });
  });

  it('lists submit as the merge method of a submit host', async () => {
    const { app } = routesWith(changeHost);
    const response = await request(app).get('/api/source-control/review/capabilities').query({ instance }).expect(200);
    expect(response.body).toMatchObject({ mergeChangeRequests: true, mergeMethods: ['submit'] });
  });
});

