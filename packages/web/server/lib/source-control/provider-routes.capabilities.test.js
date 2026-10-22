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
