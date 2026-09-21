import { describe, expect, it, vi } from 'vitest';
import { registerSourceControlRoutes } from './routes.js';
import express from 'express';
import { once } from 'node:events';
import { createBindingService } from './binding-service.js';
import { configureWebAuxiliaryBinding, configureWebTransportBinding, createWebSourceControlAPI } from '../../../src/api/source-control';
import { createHttpsCredentialReference } from '../git/credential-resolver.js';

it('configures managed HTTPS through the web Git adapter, HTTP route and binding service without leaking secrets', async () => {
  const endpoint = { rawUrl: 'https://github.com/team/repo.git', displayUrl: 'https://github.com/team/repo.git', fingerprint: 'fingerprint' };
  const auxiliaryEndpoint = { displayUrl: 'https://modules.example/module.git', fingerprint: 'auxiliary-fingerprint' };
  const repository = { supported: true, repositoryId: 'repo_one', configRevision: 'config_one', bare: false,
    remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }], transportRevision: 'private-transport',
  };
  let record = { revision: 0, binding: null };
  const account = { provider: 'github', instance: 'github.com', accountId: 'credential-one' };
  const resolvedAccount = {
    accountId: account.accountId, credentialId: account.accountId, credentialRevision: 2,
    providerUserId: 'github.com#42', status: 'valid', accessToken: 'canary-runtime-secret',
    source: 'oauth', user: { id: 42, login: 'safe-user' },
  };
  const service = createBindingService({
    resolveRepository: async () => repository,
    resolveTransportRepository: async () => repository,
    readTransportAccount: async () => resolvedAccount,
    resolveCheckoutAuxiliary: async ({ kind, path }) => ({ kind, path, endpoint: auxiliaryEndpoint }),
    store: {
      read: async () => record,
      compareAndSwap: async (repositoryId, revision, binding) => {
        if (record.revision !== revision) throw Object.assign(new Error('conflict'), { code: 'SOURCE_CONTROL_BINDING_CONFLICT' });
        record = { revision: revision + 1, binding: { ...binding, repositoryId, revision: revision + 1 } };
        return record;
      },
    },
  });
  const app = express();
  app.use(express.json());
  registerSourceControlRoutes(app, { bindingService: service });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const bodyLog = [];
  const responseLog = [];
  const transportFetch = async (route, options) => {
    bodyLog.push(options.body);
    const { query, ...init } = options;
    const suffix = query?.toString() ? `?${query}` : '';
    const response = await fetch(`http://127.0.0.1:${address.port}${route}${suffix}`, init);
    if (route === '/api/source-control/binding') expect(response.headers.get('cache-control')).toBe('no-store');
    responseLog.push(await response.clone().text());
    return response;
  };
  try {
    const intent = { directory: '/private/host/repo', expectedRepositoryId: 'repo_one', expectedRevision: 0,
      expectedConfigRevision: 'config_one', expectedFetchFingerprint: 'fingerprint', expectedPushFingerprint: 'fingerprint',
      remote: 'origin', transport: 'https', credentialAccount: account,
    };
    const result = await configureWebTransportBinding(intent, transportFetch);
    expect(result.status).toBe('configured');
    expect(result.binding.binding.remotes[0].credentialId).toBe(createHttpsCredentialReference({
      provider: account.provider, instance: account.instance, credentialId: account.accountId,
      credentialRevision: resolvedAccount.credentialRevision, providerUserId: resolvedAccount.providerUserId,
    }));
    expect(result.binding.binding.remotes[0].presentation).toMatchObject({
      status: 'available', source: 'oauth', username: 'safe-user', providerUserId: 'github.com#42',
    });
    expect(result.binding.binding.providers).toEqual([]);
    const read = await createWebSourceControlAPI({ fetch: transportFetch }).repositoryBinding('/private/host/repo');
    expect(read.binding?.remotes[0].presentation).toEqual({
      status: 'available', transport: 'https', provider: 'github', instance: 'github.com',
      source: 'oauth', username: 'safe-user', providerUserId: 'github.com#42',
    });
    expect(JSON.stringify(read.binding?.remotes[0].presentation)).not.toMatch(/credential-one|canary-runtime-secret/);
    const auxiliary = await configureWebAuxiliaryBinding({
      operation: 'configure', directory: '/private/host/repo', expectedRepositoryId: 'repo_one', expectedRevision: 1,
      expectedConfigRevision: 'config_one', parentRemote: 'origin', expectedParentFingerprint: 'fingerprint',
      kind: 'submodule', path: 'vendor/module', expectedEndpointFingerprint: 'auxiliary-fingerprint', transport: 'anonymous',
    }, transportFetch);
    expect(auxiliary.binding.binding?.auxiliary).toEqual([{
      kind: 'submodule', endpoint: { displayUrl: auxiliaryEndpoint.displayUrl, fingerprint: auxiliaryEndpoint.fingerprint },
      mode: 'anonymous', readiness: 'ready',
    }]);
    await expect(configureWebTransportBinding(intent, transportFetch)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE' });
    const { credentialAccount: _account, ...base } = intent;
    await expect(configureWebTransportBinding({ ...base, expectedRevision: 1, transport: 'system', unverifiedConfirmed: false }, transportFetch))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    await expect(configureWebTransportBinding({ ...intent, expectedRevision: 2, credentialAccount: { ...account, provider: 'gitlab', instance: 'https://gitlab.com' } }, transportFetch))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    expect(record.revision).toBe(2);
    expect(bodyLog.join('')).not.toMatch(/canary-runtime-secret|credentialId|rawUrl/);
    expect(responseLog.join('')).not.toMatch(/canary-runtime-secret|\/private\/host|rawUrl|private-transport/);
    expect(bodyLog).toHaveLength(6);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

describe('source-control provider registry', () => {
  it.each([
    ['SOURCE_CONTROL_BINDING_STALE', 409],
    ['SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH', 409],
    ['SOURCE_CONTROL_BINDING_CONFLICT', 409],
    ['INVALID_SOURCE_CONTROL_BINDING', 400],
    ['SOURCE_CONTROL_LOCK_BUSY', 503],
    ['SOURCE_CONTROL_LOCK_FAILED', 500],
  ])('routes narrow provider mutations and preserves %s failures', async (code, httpStatus) => {
    const handlers = new Map();
    const app = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), post: vi.fn((route, handler) => handlers.set(route, handler)) };
    const current = { revision: 2, binding: null };
    const mutateProvider = vi.fn().mockResolvedValueOnce(current).mockRejectedValueOnce(Object.assign(new Error('Reload and repair'), { code, current, status: httpStatus }));
    registerSourceControlRoutes(app, { bindingService: { mutateProvider }, gitlab: { store: {
      listInstances: async () => [],
      readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
    } } });
    const input = { directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 1, operation: 'remove', target: {
      provider: 'github', instance: 'github.com', accountId: 'github#1', primaryRemote: 'origin',
    } };
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const handler = handlers.get('/api/source-control/binding/provider');
    await handler({ body: input }, { json, status });
    expect(json).toHaveBeenLastCalledWith(current);
    await handler({ body: input }, { json, status });
    expect(mutateProvider).toHaveBeenCalledTimes(2);
    expect(mutateProvider).toHaveBeenLastCalledWith(input);
    expect(status).toHaveBeenCalledWith(httpStatus);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ code }));
  });
  it('registers GitHub aliases and GitLab canonical routes', () => {
    const paths = [];
    const app = {
      get: vi.fn((path) => paths.push(path)),
      post: vi.fn((path) => paths.push(path)),
      put: vi.fn((path) => paths.push(path)),
      delete: vi.fn((path) => paths.push(path)),
    };
    registerSourceControlRoutes(app, { gitlab: { authFile: '/unused/source-control-auth.json', store: {
      readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
    } } });
    expect(paths).toContain('/api/source-control/github/capabilities');
    expect(paths).toContainEqual(['/api/github/auth/status', '/api/source-control/github/auth/status']);
    expect(paths).toContain('/api/source-control/gitlab/capabilities');
    expect(paths).toContain('/api/source-control/gitlab/auth/token');
    expect(paths).toContain('/api/source-control/gitlab/auth/accounts');
    expect(paths).toContainEqual(['/api/github/auth/accounts', '/api/source-control/github/auth/accounts']);
    expect(paths).toContain('/api/source-control/instances');
    expect(paths).toContain('/api/source-control/repository-context');
    expect(paths).toContain('/api/source-control/binding');
    expect(paths).toContain('/api/source-control/binding/transport/remove');
    expect(paths).toContain('/api/source-control/binding/reset');
  });

  it('routes only explicit transport removal and confirmed binding reset intents', async () => {
    const handlers = new Map();
    const removeTransportBinding = vi.fn(async () => ({ revision: 3, binding: { remotes: [] } }));
    const resetRepositoryBinding = vi.fn(async () => ({ revision: 4, binding: null }));
    const app = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), post: vi.fn((route, handler) => handlers.set(route, handler)) };
    registerSourceControlRoutes(app, { bindingService: { removeTransportBinding, resetRepositoryBinding }, gitlab: { store: {
      listInstances: async () => [], readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
    } } });
    const removal = { directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2,
      expectedConfigRevision: 'config_one', expectedFetchFingerprint: 'fetch', expectedPushFingerprint: 'push', remote: 'origin',
    };
    const reset = { directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 3,
      expectedConfigRevision: 'config_one', confirmed: true,
    };
    const json = vi.fn();
    await handlers.get('/api/source-control/binding/transport/remove')({ body: removal }, { json });
    await handlers.get('/api/source-control/binding/reset')({ body: reset }, { json });
    expect(removeTransportBinding).toHaveBeenCalledExactlyOnceWith(removal);
    expect(resetRepositoryBinding).toHaveBeenCalledExactlyOnceWith(reset);
    expect(json).toHaveBeenCalledTimes(2);
  });

  it('lists defaults and configured self-managed GitLab instances without duplicates', async () => {
    const handlers = new Map();
    const app = {
      get: vi.fn((route, handler) => {
        if (Object.prototype.toString.call(route) === '[object String]') handlers.set(route, handler);
      }),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    registerSourceControlRoutes(app, { gitlab: { store: {
      listInstances: async () => ['https://gitlab.com', 'https://gitlab.example.com'],
      readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
    } } });
    const json = vi.fn();

    await handlers.get('/api/source-control/instances')({}, { json });

    expect(json).toHaveBeenCalledWith({ instances: [
      { provider: 'github', instance: 'github.com' },
      { provider: 'gitlab', instance: 'https://gitlab.com' },
      { provider: 'gitlab', instance: 'https://gitlab.example.com' },
    ] });
  });

  it('does not expose generic whole-binding replacement or deletion routes', () => {
    const app = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    registerSourceControlRoutes(app, {
      bindingService: {},
      gitlab: { store: {
        listInstances: async () => [],
        readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
      } },
    });
    expect(app.put).not.toHaveBeenCalledWith('/api/source-control/binding', expect.anything());
    expect(app.delete).not.toHaveBeenCalledWith('/api/source-control/binding', expect.anything());
  });

  it('reconciles bindings before an exact provider account is removed', async () => {
    const handlers = new Map();
    const account = { id: 'https://gitlab.example.com#9', token: 'secret', user: { id: 9, login: 'user' }, source: 'pat', status: 'valid' };
    const removeAccount = vi.fn(async () => true);
    const accountUnavailable = vi.fn(async () => []);
    const app = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn((route, handler) => {
        if (Object.prototype.toString.call(route) === '[object String]') handlers.set(route, handler);
      }),
    };
    registerSourceControlRoutes(app, {
      bindingService: { accountUnavailable },
      gitlab: { store: {
        listInstances: async () => [],
        readInstance: async () => ({ activeAccountId: account.id, accounts: [account], cliDisabled: false, cliActive: false }),
        removeAccount,
      } },
    });
    const json = vi.fn();

    await handlers.get('/api/source-control/gitlab/auth')({ query: { instance: 'https://gitlab.example.com', accountId: account.id } }, { json });

    expect(accountUnavailable).toHaveBeenCalledWith({ provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: account.id });
    expect(removeAccount).toHaveBeenCalledWith('https://gitlab.example.com', account.id);
    expect(accountUnavailable.mock.invocationCallOrder[0]).toBeLessThan(removeAccount.mock.invocationCallOrder[0]);
  });

  it('returns binding authority plus provider-neutral source resolution', async () => {
    const bindingService = { validateReadContext: vi.fn(), validateMutationContext: vi.fn(), accountUnavailable: vi.fn() };
    const app = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };

    const registered = registerSourceControlRoutes(app, {
      bindingService,
      gitlab: { store: {
        listInstances: async () => [],
        readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
      } },
    });

    expect(registered).toMatchObject(bindingService);
    expect(registered.resolveChangeRequestSource).toBeInstanceOf(Function);
    await expect(registered.resolveChangeRequestSource({ context: { provider: 'unknown' } }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400 });
  });

  it('accepts injected mutation executors without constructing or touching a store', () => {
    const mutationExecutor = { execute: vi.fn() };
    const bindingService = { validateReadContext: vi.fn(), validateMutationContext: vi.fn(), accountUnavailable: vi.fn() };
    const dependencies = {
      bindingService,
      mutationExecutor,
      get mutationStore() { throw new Error('mutation store must not be read'); },
      gitlab: { store: {
        listInstances: async () => [],
        readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
      } },
    };
    const app = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };

    expect(() => registerSourceControlRoutes(app, dependencies)).not.toThrow();
  });

  it('builds the shared executor around an injected mutation store', () => {
    const mutationStore = { claim: vi.fn(), complete: vi.fn(), read: vi.fn(), withExecutionLock: vi.fn() };
    const bindingService = { validateReadContext: vi.fn(), validateMutationContext: vi.fn(), accountUnavailable: vi.fn() };
    const app = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };

    expect(() => registerSourceControlRoutes(app, {
      configRoot: '/unused', bindingService, mutationStore,
      gitlab: { store: {
        listInstances: async () => [],
        readInstance: async () => ({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false }),
      } },
    })).not.toThrow();
  });
});
