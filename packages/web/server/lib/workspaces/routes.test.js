import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { registerWorkspaceRoutes, resolveWorkspacePluginSpec } from './routes.js';
import { buildPluginOptions, readWorkspaceSettings, sanitizeWorkspaceSettingsUpdate } from './policy.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
const runtimeImage = `registry.example/workspace@sha256:${'a'.repeat(64)}`;

describe('workspace release defaults', () => {
  it('uses the signed public release digests when image settings are empty', () => {
    const settings = readWorkspaceSettings({});
    const options = buildPluginOptions(settings, { requireComplete: true });

    expect(options.defaultImage).toBe('ghcr.io/openchamber/opencode-workspace@sha256:40266ce54560149396cdc89395fa26df08f8924e4f377acbf12a88da08b2c141');
    expect(options.allowedImages).toEqual([options.defaultImage]);
    expect(options.egress.gatewayImage).toBe('ghcr.io/openchamber/workspace-egress-gateway@sha256:37c1452849212c5e9b2b62257792ca092c44c5ebba6d165667f235164e571555');
  });

  it('saves a Kubernetes configuration that leaves DNS to be discovered from the cluster', () => {
    // The provider reads the cluster's DNS service address itself. Refusing to save
    // without it rejected the entire settings update — including changes about
    // something else entirely — and rolled every one of them back.
    const kubernetesSettings = readWorkspaceSettings({ secureWorkspacesDefaultProvider: 'kubernetes' });
    expect(() => buildPluginOptions(kubernetesSettings, { requireComplete: true })).not.toThrow();
    expect(buildPluginOptions(kubernetesSettings, { requireComplete: true }).egress.dnsCIDRs).toEqual([]);
  });

  it('still passes a configured DNS range through to the provider', () => {
    const settings = readWorkspaceSettings({ secureWorkspacesDefaultProvider: 'kubernetes', secureWorkspacesEgressDnsCIDRs: '10.43.0.10/32' });

    expect(buildPluginOptions(settings, { requireComplete: true }).egress.dnsCIDRs).toEqual(['10.43.0.10/32']);
  });

  it('requires an external proxy CIDR only for Kubernetes', () => {
    const appleSettings = readWorkspaceSettings({
      secureWorkspacesDefaultProvider: 'apple-container',
      secureWorkspacesEgressMode: 'external',
      secureWorkspacesEgressProxyUrl: 'http://127.0.0.1:3128',
    });
    expect(() => buildPluginOptions(appleSettings, { requireComplete: true })).not.toThrow();

    const kubernetesSettings = readWorkspaceSettings({
      secureWorkspacesDefaultProvider: 'kubernetes',
      secureWorkspacesEgressMode: 'external',
      secureWorkspacesEgressProxyUrl: 'http://10.0.0.10:3128',
      secureWorkspacesEgressDnsCIDRs: '10.0.0.53/32',
    });
    expect(() => buildPluginOptions(kubernetesSettings, { requireComplete: true })).toThrow('Kubernetes external workspace egress requires a proxy CIDR');
  });
});

function routeRegistry() {
  const routes = new Map();
  return {
    app: {
      get(route, handler) { routes.set(`GET ${route}`, handler); },
      post(route, handler) { routes.set(`POST ${route}`, handler); },
      delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
    },
    route(method, value) { return routes.get(`${method} ${value}`); },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers ??= {}; this.headers[name] = value; },
    send(body) { this.body = body; return this; },
  };
}

function workspace(directory) {
  return {
    id: 'workspace-1',
    type: 'docker',
    projectID: 'project-1',
    directory,
    extra: {
      version: 1,
      runtimeLayoutVersion: 1,
      provider: 'docker',
      controlPlaneWorkspaceID: 'workspace-1',
      providerResourceID: 'resource-1',
      projectID: 'project-1',
    },
  };
}

function exportArtifact(directory, overrides = {}) {
  const content = Buffer.from('new\n');
  const contentHash = hash(content);
  const value = {
    version: 1,
    id: 'export-1',
    controlPlaneWorkspaceID: 'workspace-1',
    providerResourceID: 'resource-1',
    projectID: 'project-1',
    provider: 'docker',
    baselineGeneration: 'generation-1',
    targetDirectory: directory,
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    files: [{
      id: 'file-1', kind: 'add', newPath: 'new.txt', binary: false, newMode: 0o644,
      resultHash: contentHash, resultBlob: contentHash, baselineBlob: null, textHunks: [], old: null,
      next: { path: 'new.txt', type: 'file', mode: 0o644, size: content.length, hash: contentHash, binary: false },
    }],
    blobs: [{ hash: contentHash, size: content.length, contentBase64: content.toString('base64') }],
    ...overrides,
  };
  delete value.integrityHash;
  value.integrityHash = hash(JSON.stringify(value));
  return value;
}

function dependencies(overrides = {}) {
  const directory = overrides.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-routes-'));
  const calls = [];
  const currentWorkspace = overrides.workspace ?? workspace(directory);
  const operations = {
    validateProvider: vi.fn(async () => ({ available: true, version: '1' })),
    cleanupWorkspace: vi.fn(async () => { calls.push('cleanup'); return { ok: true, remainingResources: [], diagnostics: [] }; }),
    reconcileWorkspace: vi.fn(async () => ({ ok: true, status: 'ready', diagnostics: ['resources verified'] })),
    exportWorkspace: vi.fn(async () => exportArtifact(directory)),
    ...overrides.operations,
  };
  const remove = vi.fn(async () => { calls.push('remove'); return { data: true }; });
  const list = overrides.list ?? vi.fn(async () => ({ data: [currentWorkspace] }));
  const create = vi.fn(async () => ({ data: currentWorkspace }));
  const status = vi.fn(async () => ({ data: [{ workspaceID: currentWorkspace.id, status: 'connected' }] }));
  const sessionCreate = vi.fn(async (input) => ({ data: { id: 'ses_routed00000001', directory: '/workspace', workspaceID: input?.workspace }, response: { status: 201 } }));
  const sessionGet = vi.fn(async () => ({ data: { id: 'ses_routed00000001', workspaceID: currentWorkspace.id } }));
  const createWorkspaceProviderOperations = vi.fn(() => operations);
  return {
    directory,
    calls,
    operations,
    remove,
    list,
    create,
    workspaceStatus: status,
    createWorkspaceProviderOperations,
    validateDirectoryPath: vi.fn(async (candidate) => ({ ok: true, directory: candidate })),
    readSettingsFromDiskMigrated: vi.fn(async () => ({
      activeProjectId: 'host-project',
      projects: [{ id: 'host-project', path: directory }],
      secureWorkspacesEnabled: true,
      secureWorkspacesImage: runtimeImage,
      secureWorkspacesEgressMode: 'external',
      secureWorkspacesEgressProxyUrl: 'http://trusted-proxy:3128',
      secureWorkspacesEgressProxyCIDR: '10.0.0.4/32',
      secureWorkspacesEgressDnsCIDRs: '10.0.0.53/32',
    })),
    persistSettings: vi.fn(async (changes) => ({
      secureWorkspacesEnabled: true,
      secureWorkspacesImage: runtimeImage,
      secureWorkspacesEgressMode: 'external',
      secureWorkspacesEgressProxyUrl: 'http://trusted-proxy:3128',
      secureWorkspacesEgressProxyCIDR: '10.0.0.4/32',
      secureWorkspacesEgressDnsCIDRs: '10.0.0.53/32',
      ...changes,
    })),
    restoreSettingsFields: vi.fn(async () => ({})),
    sanitizeSettingsUpdate: vi.fn((changes) => changes),
    sanitizeProjects: (projects) => projects,
    openchamberDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-route-data-')),
    refreshOpenCodeAfterConfigChange: vi.fn(async () => ({ reloaded: true, external: false })),
    listPluginEntries: vi.fn(() => []),
    createPluginEntry: vi.fn(),
    updatePluginEntry: vi.fn(),
    deletePluginEntry: vi.fn(),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    sessionCreate,
    sessionGet,
    createOpenCodeClient: vi.fn(() => ({
      experimental: { workspace: {
        list,
        remove,
        create,
        status,
        adapter: { list: vi.fn(async () => ({ data: [], response: { status: 200 } })) },
      } },
      session: { create: sessionCreate, get: sessionGet },
    })),
    createWorkspaceProviderOperations,
    uiAuthController: {
      resolveAuthContext: vi.fn(async () => ({ type: 'session', token: 'test-session' })),
      consumeReauthProof: vi.fn(async () => true),
    },
    ...overrides.dependencies,
  };
}

// The exact options startup reconciliation computes from the settings dependencies() persists.
const reconciledOptions = () => buildPluginOptions(readWorkspaceSettings({
  secureWorkspacesEnabled: true,
  secureWorkspacesImage: runtimeImage,
  secureWorkspacesEgressMode: 'external',
  secureWorkspacesEgressProxyUrl: 'http://trusted-proxy:3128',
  secureWorkspacesEgressProxyCIDR: '10.0.0.4/32',
  secureWorkspacesEgressDnsCIDRs: '10.0.0.53/32',
}), { requireComplete: true });

describe('workspace provider operation routes', () => {
  it('does not load provider operations during route registration', () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { createWorkspaceProviderOperations: undefined, workspaceOperationsLoader: vi.fn() } });
    registerWorkspaceRoutes(registry.app, deps);
    expect(deps.workspaceOperationsLoader).not.toHaveBeenCalled();
    expect(registry.route('POST', '/api/workspaces/handoffs/draft')).toBeTypeOf('function');
    expect(registry.route('POST', '/api/workspaces/handoffs/:operationID/commit')).toBeTypeOf('function');
    expect(registry.route('GET', '/api/workspaces/handoffs/:operationID')).toBeTypeOf('function');
    expect(registry.route('DELETE', '/api/workspaces/handoffs/:operationID/target')).toBeTypeOf('function');
    expect(registry.route('POST', '/api/experimental/workspace/warp')).toBeUndefined();
  });

  it('uses an OpenCode-compatible random provisional ID for create', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^wrk_[a-f0-9]{32}$/) }));
  });

  it('adopts a create OpenCode gave up waiting on once authoritative status proves it connected', async () => {
    // OpenCode's post-create wait is a few seconds; a Docker cold start is longer. Its
    // timeout says it stopped watching, not that the workspace failed, so the row it
    // kept is checked against authoritative status before anything is destroyed.
    const registry = routeRegistry();
    const deps = dependencies();
    let provisionalID = '';
    deps.create.mockImplementation(async ({ id }) => { provisionalID = id; throw new Error('Timed out waiting for global event'); });
    deps.list.mockImplementation(async () => ({ data: provisionalID ? [{ ...workspace(deps.directory), id: provisionalID }] : [] }));
    deps.workspaceStatus.mockImplementation(async () => ({ data: provisionalID ? [{ workspaceID: provisionalID, status: 'connected' }] : [] }));
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ id: provisionalID, status: 'connected', provisional: false });
    expect(deps.operations.cleanupWorkspace).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('answers connecting for an adopted create that has not connected within the bounded wait', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { workspaceCreateStatusMaxAttempts: 2, workspaceCreateStatusPollIntervalMs: 0 } });
    let provisionalID = '';
    deps.create.mockImplementation(async ({ id }) => { provisionalID = id; throw new Error('Timed out waiting for global event'); });
    deps.list.mockImplementation(async () => ({ data: provisionalID ? [{ ...workspace(deps.directory), id: provisionalID }] : [] }));
    deps.workspaceStatus.mockImplementation(async () => ({ data: provisionalID ? [{ workspaceID: provisionalID, status: 'connecting' }] : [] }));
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    // Same evidence as a successful create whose status wait timed out — same answer:
    // the row stays visible and retryable rather than being silently destroyed.
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ id: provisionalID, status: 'connecting', provisional: true, retryable: true });
    expect(deps.operations.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('keeps waiting through disconnected, which OpenCode stamps on every workspace at sync start', async () => {
    // A booting Kubernetes workspace reports `disconnected` before its port-forward is
    // up. Treating that as terminal destroyed the healthy workspace mid-boot.
    const registry = routeRegistry();
    const deps = dependencies();
    const statuses = ['disconnected', 'disconnected', 'connected'];
    deps.create.mockImplementation(async ({ id }) => ({ data: { ...workspace(deps.directory), id } }));
    deps.workspaceStatus.mockImplementation(async () => {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      const id = deps.create.mock.calls[0]?.[0]?.id;
      return { data: id ? [{ workspaceID: id, status }] : [] };
    });
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ status: 'connected' });
    expect(deps.operations.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('answers connecting rather than destroying a workspace that stays disconnected all wait', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { workspaceCreateStatusMaxAttempts: 2, workspaceCreateStatusPollIntervalMs: 0 } });
    deps.create.mockImplementation(async ({ id }) => ({ data: { ...workspace(deps.directory), id } }));
    deps.workspaceStatus.mockImplementation(async () => {
      const id = deps.create.mock.calls[0]?.[0]?.id;
      return { data: id ? [{ workspaceID: id, status: 'disconnected' }] : [] };
    });
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ status: 'connecting', provisional: true, retryable: true });
    expect(deps.operations.cleanupWorkspace).not.toHaveBeenCalled();
  });

  it('still compensates a create failure that is not the upstream wait timeout', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    deps.create.mockImplementation(async () => { throw new Error('adapter refused'); });
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('adapter refused');
    expect(deps.workspaceStatus).not.toHaveBeenCalled();
  });

  it('compensates the upstream wait timeout when no authoritative row survived it', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ list: vi.fn(async () => ({ data: [] })) });
    deps.create.mockImplementation(async () => { throw new Error('Timed out waiting for global event'); });
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ compensation: expect.objectContaining({ recordPresent: false }) });
  });

  it('reports remote external OpenCode as explicitly unsupported from runtime authority', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { getWorkspaceRuntimeBoundary: () => ({ supported: false, error: 'remote external unsupported', diagnostics: ['authoritative external runtime'] }) } });
    registerWorkspaceRoutes(registry.app, deps);
    const compatibility = response();
    await registry.route('GET', '/api/workspaces/compatibility')({ query: {} }, compatibility);
    expect(compatibility.statusCode).toBe(200);
    expect(compatibility.body).toMatchObject({ supported: false, handoffSupported: false, error: 'remote external unsupported', diagnostics: ['authoritative external runtime'] });
    const draft = response();
    await registry.route('POST', '/api/workspaces/handoffs/draft')({ body: {} }, draft);
    expect(draft.statusCode).toBe(501);
    expect(draft.body.error).toBe('remote external unsupported');
  });

  it('validates through injected operations using persisted policy and source directory', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('POST', '/api/workspaces/providers/validate')({ method: 'POST', body: { provider: 'docker', sourceDirectory: '/attacker', egressHttpProxy: 'http://attacker' }, query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(deps.operations.validateProvider).toHaveBeenCalledWith('docker');
    expect(deps.createWorkspaceProviderOperations).toHaveBeenCalledWith(expect.objectContaining({
      sourceDirectory: deps.directory,
      policy: expect.objectContaining({ egress: expect.objectContaining({ proxyUrl: 'http://trusted-proxy:3128' }) }),
    }));
    expect(deps.createWorkspaceProviderOperations.mock.calls[0][0].policy).toMatchObject({
      defaultImage: runtimeImage,
      allowedImages: [runtimeImage],
      requirePinnedImage: true,
      docker: { networkMode: 'per-workspace-internal', pidsLimit: 512 },
      kubernetes: { connectivity: 'port-forward', networkPolicy: 'default-deny', storage: '8Gi', cpuRequest: '250m', memoryRequest: '512Mi', cpuLimit: '2', memoryLimit: '4Gi' },
      appleContainer: { networkMode: 'per-workspace-host-only' },
      retention: { preserveOnDelete: false },
      credentials: { modelAuth: 'explicit-opencode-auth-content' },
    });
  });

  it('returns an explicit unavailable result for an incompatible pinned package', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { createWorkspaceProviderOperations: undefined, workspaceOperationsLoader: vi.fn(async () => { throw Object.assign(new Error('missing operations export'), { statusCode: 503 }); }) } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('POST', '/api/workspaces/providers/validate')({ method: 'POST', body: { provider: 'docker' }, query: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toContain('missing operations export');
  });

  it('passes the generated provisional ID unchanged and waits for connected status', async () => {
    const provisionalID = 'provisional-connected';
    const current = workspace('/unused');
    current.id = provisionalID;
    current.extra.controlPlaneWorkspaceID = provisionalID;
    const registry = routeRegistry();
    const deps = dependencies({ workspace: current, dependencies: { randomWorkspaceID: () => provisionalID, workspaceCreateStatusPollIntervalMs: 0 } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory, extra: { ignored: true } }, query: {} }, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ id: provisionalID, status: 'connected', provisional: false });
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ id: provisionalID, type: 'docker', directory: deps.directory }));
    expect(deps.workspaceStatus).toHaveBeenCalledWith({ directory: deps.directory }, { signal: expect.any(AbortSignal) });
  });

  it('returns the original create failure without cleanup when the exact provisional row is absent', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { randomWorkspaceID: () => 'absent-id' } });
    deps.create.mockResolvedValue({ error: { name: 'create failed' }, response: { statusText: 'provider create failed' } });
    deps.list.mockResolvedValue({ data: [workspace(deps.directory)] });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'provider create failed', provisionalID: 'absent-id', retryable: false, compensation: { completed: true, recordPresent: false, remainingResources: [] } });
    expect(deps.operations.cleanupWorkspace).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('surfaces the structured OpenCode workspace create error', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { randomWorkspaceID: () => 'wrk_structured_error' } });
    deps.create.mockResolvedValue({ error: { name: 'WorkspaceCreateError', data: { message: 'provider rejected workspace policy' } }, response: { statusText: 'Bad Request' } });
    deps.list.mockResolvedValue({ data: [] });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.body.error).toBe('provider rejected workspace policy');
  });

  it('compensates only the exact failed row and removes it after complete provider cleanup', async () => {
    const provisionalID = 'failed-row';
    const current = workspace('/unused');
    current.id = provisionalID;
    current.extra.controlPlaneWorkspaceID = provisionalID;
    const registry = routeRegistry();
    const deps = dependencies({ workspace: current, dependencies: { randomWorkspaceID: () => provisionalID } });
    deps.create.mockResolvedValue({ error: {}, response: { statusText: 'create failed' } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(deps.calls).toEqual(['cleanup', 'remove']);
    expect(deps.remove).toHaveBeenCalledWith({ id: provisionalID, directory: deps.directory });
    expect(res.body.compensation).toMatchObject({ completed: true, recordPresent: false, remainingResources: [] });
  });

  it('preserves the exact failed row when compensation cleanup is partial', async () => {
    const provisionalID = 'partial-row';
    const current = workspace('/unused');
    current.id = provisionalID;
    current.extra.controlPlaneWorkspaceID = provisionalID;
    const registry = routeRegistry();
    const deps = dependencies({ workspace: current, operations: { cleanupWorkspace: vi.fn(async () => ({ ok: false, remainingResources: ['container:runtime'], diagnostics: ['runtime remains'] })) }, dependencies: { randomWorkspaceID: () => provisionalID } });
    deps.create.mockResolvedValue({ error: {}, response: { statusText: 'create failed' } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.body).toMatchObject({ retryable: true, remainingResources: ['container:runtime'], compensation: { completed: false, recordPresent: true } });
    expect(res.body.diagnostics).toContain('runtime remains');
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('compensates an explicit error status instead of returning create success', async () => {
    const provisionalID = 'status-error-row';
    const current = workspace('/unused');
    current.id = provisionalID;
    current.extra.controlPlaneWorkspaceID = provisionalID;
    const registry = routeRegistry();
    const deps = dependencies({ workspace: current, dependencies: { randomWorkspaceID: () => provisionalID, workspaceCreateStatusPollIntervalMs: 0 } });
    deps.workspaceStatus.mockResolvedValue({ data: [{ workspaceID: provisionalID, status: 'error' }] });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('reported error');
    expect(deps.calls).toEqual(['cleanup', 'remove']);
  });

  it('returns a retryable provisional response when authoritative status stays connecting', async () => {
    const provisionalID = 'status-timeout-row';
    const current = workspace('/unused');
    current.id = provisionalID;
    current.extra.controlPlaneWorkspaceID = provisionalID;
    const registry = routeRegistry();
    const deps = dependencies({ workspace: current, dependencies: { randomWorkspaceID: () => provisionalID, workspaceCreateStatusPollIntervalMs: 0, workspaceCreateStatusMaxAttempts: 2 } });
    deps.workspaceStatus.mockResolvedValue({ data: [{ workspaceID: provisionalID, status: 'connecting' }] });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/create')({ body: { type: 'docker', directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ id: provisionalID, status: 'connecting', provisional: true, retryable: true });
    expect(deps.workspaceStatus).toHaveBeenCalledTimes(2);
    expect(deps.operations.cleanupWorkspace).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('cleans provider resources before removing the official SDK record', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('DELETE', '/api/workspaces/:id')({ params: { id: 'workspace-1' }, body: { directory: deps.directory }, query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(deps.calls).toEqual(['cleanup', 'remove']);
  });

  it('returns retryable cleanup failure and preserves the SDK record', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ operations: { cleanupWorkspace: vi.fn(async () => ({ ok: false, remainingResources: ['container:runtime'] })) } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('DELETE', '/api/workspaces/:id')({ params: { id: 'workspace-1' }, body: { directory: deps.directory }, query: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ cleaned: false, retryable: true, remainingResources: ['container:runtime'] });
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('records the route of a session created through the intercepted proxy path', async () => {
    // OpenCode exposes no session→workspace link on any read path, so the record
    // written here at creation is the only durable association the sidebar can use.
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/session')({ query: { directory: deps.directory, workspace: 'workspace-1' }, body: { title: 'Routed' } }, res, () => { throw new Error('must not fall through when workspace is explicit'); });

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ id: 'ses_routed00000001' });
    expect(deps.sessionCreate).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'workspace-1', directory: deps.directory, title: 'Routed' }));

    const routesRes = response();
    await registry.route('GET', '/api/workspaces/session-routes')({ query: {} }, routesRes);
    expect(routesRes.body.routes).toEqual([expect.objectContaining({ sessionID: 'ses_routed00000001', workspaceID: 'workspace-1', projectDirectory: deps.directory })]);
  });

  it('leaves an ordinary session create to the generic proxy untouched', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);

    const next = vi.fn();
    await registry.route('POST', '/api/session')({ query: { directory: deps.directory }, body: { title: 'Host session' } }, response(), next);

    expect(next).toHaveBeenCalled();
    expect(deps.sessionCreate).not.toHaveBeenCalled();
  });

  it('records the route of a session started through the ordinary session route', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);

    const res = response();
    await registry.route('POST', '/api/workspaces/sessions/start')({ headers: {}, body: { operationID: 'op-routed-1', directory: deps.directory, title: '' } }, res);

    expect(res.statusCode).toBe(201);
    const routesRes = response();
    await registry.route('GET', '/api/workspaces/session-routes')({ query: {} }, routesRes);
    expect(routesRes.body.routes).toEqual([expect.objectContaining({ sessionID: 'ses_routed00000001', workspaceID: 'workspace-1', projectDirectory: deps.directory })]);
  });

  it('starts a workspace session from chat without a second credential', async () => {
    // Creating a workspace from chat is the same operation as creating one from the
    // panel. Prompting in one place and not the other would be the worse of both answers.
    const registry = routeRegistry();
    const deps = dependencies();
    const rawDirectory = deps.directory.replaceAll('\\', '/');
    deps.validateDirectoryPath = vi.fn(async (candidate) => ({ ok: true, directory: candidate === rawDirectory ? deps.directory : candidate }));
    deps.list.mockResolvedValue({ data: [] });
    deps.workspaceStatus.mockResolvedValue({ data: [] });
    deps.uiAuthController.consumeReauthProof = vi.fn(async () => false);
    // Authorization is what this asserts, so creation is made to fail immediately
    // afterwards rather than running the whole provisioning flow.
    deps.create.mockRejectedValue(new Error('provider refused'));
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/sessions/start')({ headers: {}, body: { operationID: 'op-12345678', directory: rawDirectory, title: '' } }, res);

    expect(res.statusCode).not.toBe(428);
    expect(deps.uiAuthController.consumeReauthProof).not.toHaveBeenCalled();
  });

  it('still refuses a client that lacks the capability to create a workspace from chat', async () => {
    // Removing the prompt must not remove the check that decides who may do this at all.
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: {
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => ({ type: 'client', clientId: 'paired-1', client: { capabilities: ['workspace.use'] } })),
        consumeReauthProof: vi.fn(async () => true),
      },
    } });
    deps.list.mockResolvedValue({ data: [] });
    deps.workspaceStatus.mockResolvedValue({ data: [] });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('POST', '/api/workspaces/sessions/start')({ headers: {}, body: { operationID: 'op-12345678', directory: deps.directory, title: '' } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'WORKSPACE_SESSION_UNAUTHORIZED' });
  });

  it('reports environment readiness without a step-up prompt and without leaking provider output', async () => {
    const registry = routeRegistry();
    const deps = dependencies({
      operations: {
        validateProvider: vi.fn(async (provider) => {
          if (provider === 'docker') throw Object.assign(new Error('Docker daemon is not reachable: connect ENOENT //./pipe/docker_engine'), { code: 'WORKSPACE_PROVIDER_DAEMON_UNAVAILABLE' });
          return { available: true, diagnostics: [] };
        }),
      },
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('GET', '/api/workspaces/readiness')({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, defaultProvider: 'docker' });
    expect(res.body.providers).toContainEqual(expect.objectContaining({ provider: 'docker', available: false, code: 'WORKSPACE_PROVIDER_DAEMON_UNAVAILABLE' }));
    expect(res.body.providers.every((entry) => !('message' in entry) && !('error' in entry))).toBe(true);
    // Readiness carries the ordered path to a working provider, with the failing
    // requirement identified rather than left for the surface to infer.
    const docker = res.body.providers.find((entry) => entry.provider === 'docker');
    expect(docker.steps.map((step) => [step.id, step.status])).toEqual([['cli', 'satisfied'], ['daemon', 'blocked']]);
    expect(deps.uiAuthController.consumeReauthProof).not.toHaveBeenCalled();
  });

  it('marks isolation verified once the provider reports a passing verdict', async () => {
    const registry = routeRegistry();
    const deps = dependencies({
      operations: {
        // A passing probe carries no diagnostics, so a verdict read from diagnostic
        // wording rather than the field is silently lost and the step never completes.
        validateProvider: vi.fn(async () => ({ available: true, diagnostics: [], isolation: { verdict: 'enforced' } })),
      },
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('GET', '/api/workspaces/readiness')({ query: {} }, res);

    const kubernetes = res.body.providers.find((entry) => entry.provider === 'kubernetes');
    expect(kubernetes.steps.find((step) => step.id === 'isolation').status).toBe('satisfied');
  });

  it('does not call isolation verified when the provider has not probed it', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ operations: { validateProvider: vi.fn(async () => ({ available: true, diagnostics: [] })) } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('GET', '/api/workspaces/readiness')({ query: {} }, res);

    const kubernetes = res.body.providers.find((entry) => entry.provider === 'kubernetes');
    expect(kubernetes.steps.find((step) => step.id === 'isolation').status).toBe('unknown');
  });

  it('names the workspaces built under settings that are no longer in force', async () => {
    const registry = routeRegistry();
    const drifted = { id: 'ws-old', type: 'docker', projectID: 'p1' };
    const current = { id: 'ws-new', type: 'docker', projectID: 'p1' };
    const deps = dependencies({
      operations: {
        describeWorkspacePolicyState: vi.fn(async (workspace) => ({ matchesPolicy: workspace.id !== 'ws-old' })),
      },
      list: vi.fn(async () => ({ data: [drifted, current] })),
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('GET', '/api/workspaces/policy-state')({ query: {} }, res);

    // Reported per workspace: a panel-wide warning cannot say which one it means.
    expect(res.body).toEqual({ mismatched: ['ws-old'] });
  });

  it('flags nothing when the workspaces cannot be read, rather than guessing', async () => {
    const registry = routeRegistry();
    const deps = dependencies({
      operations: { describeWorkspacePolicyState: vi.fn(async () => { throw new Error('unreadable'); }) },
      list: vi.fn(async () => ({ data: [{ id: 'ws-1', type: 'docker', projectID: 'p1' }] })),
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('GET', '/api/workspaces/policy-state')({ query: {} }, res);

    expect(res.body).toEqual({ mismatched: [] });
  });

  it('applies only the keys a change names, leaving the rest of the configuration alone', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    // A surface that submits its whole form saves whatever its local state holds, which
    // begins at defaults — that is how an unrelated action switched the feature off.
    await registry.route('POST', '/api/workspaces/settings')({
      body: { changes: { secureWorkspacesKubernetesContext: 'kind-openchamber-np' }, activate: false },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(200);
    const persisted = deps.persistSettings.mock.calls.at(-1)?.[0] ?? {};
    expect(Object.keys(persisted)).toEqual(['secureWorkspacesKubernetesContext']);
    expect(persisted).not.toHaveProperty('secureWorkspacesEnabled');
  });

  it('reports readiness as policy-incomplete instead of failing when settings are unusable', async () => {
    const registry = routeRegistry();
    const deps = dependencies({
      dependencies: { readSettingsFromDiskMigrated: vi.fn(async () => ({ activeProjectId: 'host-project', projects: [], secureWorkspacesEnabled: false })) },
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('GET', '/api/workspaces/readiness')({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.providers.every((entry) => entry.available === false && entry.code === 'WORKSPACE_POLICY_INCOMPLETE')).toBe(true);
    expect(typeof res.body.policyError).toBe('string');
  });

  it('reconciles provider resources separately from OpenCode sync-list', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('POST', '/api/workspaces/:id/reconcile')({ params: { id: 'workspace-1' }, body: { directory: deps.directory } }, res);
    expect(res.body).toEqual({ reconciled: true, status: 'ready', diagnostics: ['resources verified'], remainingResources: [] });
    expect(deps.operations.reconcileWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'workspace-1' }));
    // Reconciling verifies provider resources against recorded state; it changes nothing
    // on the host and no longer interrupts for a password.
    expect(deps.uiAuthController.consumeReauthProof).not.toHaveBeenCalled();
  });

  it('uses only verified operations adoption for a recovered OpenCode record ID', async () => {
    const recovered = workspace('/unused');
    recovered.id = 'recovered-id';
    recovered.extra.controlPlaneWorkspaceID = 'original-id';
    const adoptWorkspace = vi.fn(async (record) => ({ ...record, extra: { ...record.extra, controlPlaneWorkspaceID: record.id, originalControlPlaneWorkspaceID: 'original-id' } }));
    const registry = routeRegistry();
    const deps = dependencies({
      workspace: recovered,
      operations: {
        adoptWorkspace,
        exportWorkspace: vi.fn(async () => exportArtifact(deps.directory, { controlPlaneWorkspaceID: 'recovered-id' })),
      },
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('GET', '/api/workspaces/:id/export')({ params: { id: 'recovered-id' }, query: { directory: deps.directory } }, res);

    expect(res.statusCode).toBe(200);
    expect(adoptWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'recovered-id', extra: expect.objectContaining({ controlPlaneWorkspaceID: 'original-id', providerResourceID: 'resource-1' }) }));
    expect(deps.operations.exportWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'recovered-id', extra: expect.objectContaining({ controlPlaneWorkspaceID: 'recovered-id', originalControlPlaneWorkspaceID: 'original-id' }) }));
  });

  it('delegates drifted-identity cleanup verification to plugin operations', async () => {
    const recovered = workspace('/unused');
    recovered.id = 'recovered-id';
    recovered.extra.controlPlaneWorkspaceID = 'original-id';
    const registry = routeRegistry();
    const deps = dependencies({ workspace: recovered });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('DELETE', '/api/workspaces/:id')({ params: { id: 'recovered-id' }, body: { directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(deps.operations.cleanupWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'recovered-id', extra: expect.objectContaining({ controlPlaneWorkspaceID: 'original-id', providerResourceID: 'resource-1' }) }));
    expect(deps.calls).toEqual(['cleanup', 'remove']);
  });

  it('returns a retryable failure when plugin operations reject a drifted cleanup identity', async () => {
    const recovered = workspace('/unused');
    recovered.id = 'forged-id';
    recovered.extra.controlPlaneWorkspaceID = 'original-id';
    const registry = routeRegistry();
    const deps = dependencies({
      workspace: recovered,
      operations: { cleanupWorkspace: vi.fn(async () => { throw new Error('Workspace recovery state identity mismatch'); }) },
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('DELETE', '/api/workspaces/:id')({ params: { id: 'forged-id' }, body: { directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ cleaned: false, retryable: true, error: 'Workspace recovery state identity mismatch' });
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('treats policy-retained storage as successful cleanup and removes the SDK record', async () => {
    const registry = routeRegistry();
    const deps = dependencies({
      operations: {
        cleanupWorkspace: vi.fn(async () => ({ ok: true, remainingResources: [], retainedResources: ['volume:data', 'volume:baseline'], diagnostics: ['Workspace storage was retained by policy'] })),
      },
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('DELETE', '/api/workspaces/:id')({ params: { id: 'workspace-1' }, body: { directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ cleaned: true, retainedResources: ['volume:data', 'volume:baseline'], diagnostics: ['Workspace storage was retained by policy'] });
    expect(deps.remove).toHaveBeenCalled();
  });

  it('surfaces the structured error code when cleanup fails with one', async () => {
    const registry = routeRegistry();
    const deps = dependencies({
      operations: { cleanupWorkspace: vi.fn(async () => { throw Object.assign(new Error('Workspace policy fingerprint does not match the active policy'), { code: 'WORKSPACE_POLICY_MISMATCH' }); }) },
    });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('DELETE', '/api/workspaces/:id')({ params: { id: 'workspace-1' }, body: { directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ cleaned: false, retryable: true, code: 'WORKSPACE_POLICY_MISMATCH' });
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('exports a validated server-cached artifact without returning blob content', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('GET', '/api/workspaces/:id/export')({ params: { id: 'workspace-1' }, query: { directory: deps.directory } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ exportID: 'export-1', provider: 'docker', review: { totalFiles: 1 } });
    expect(JSON.stringify(res.body)).not.toContain('contentBase64');
    expect(deps.operations.exportWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'workspace-1' }));
  });

  it('downloads the exact cached artifact with live identity and no-store headers, then discards it', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const exportRes = response();
    await registry.route('GET', '/api/workspaces/:id/export')({ params: { id: 'workspace-1' }, query: { directory: deps.directory } }, exportRes);
    const downloadRes = response();
    await registry.route('GET', '/api/workspaces/exports/:exportID/download')({ params: { exportID: 'export-1' }, query: { workspaceID: 'workspace-1' } }, downloadRes);
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(downloadRes.body.toString())).toMatchObject({ id: 'export-1', controlPlaneWorkspaceID: 'workspace-1', blobs: [expect.objectContaining({ contentBase64: expect.any(String) })] });
    const discardRes = response();
    await registry.route('DELETE', '/api/workspaces/exports/:exportID')({ params: { exportID: 'export-1' }, body: { workspaceID: 'workspace-1' } }, discardRes);
    expect(discardRes.body).toEqual({ discarded: true });
  });

  it('consumes the stored artifact after a successful apply', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    await registry.route('GET', '/api/workspaces/:id/export')({ params: { id: 'workspace-1' }, query: { directory: deps.directory } }, response());
    const applyRes = response();
    await registry.route('POST', '/api/workspaces/exports/:exportID/apply')({
      params: { exportID: 'export-1' },
      body: { directory: deps.directory, workspaceID: 'workspace-1', selections: [{ fileID: 'file-1' }], checkOnly: false },
    }, applyRes);
    expect(applyRes.body).toMatchObject({ applied: true, checkOnly: false, files: ['file-1'] });
    expect(fs.readFileSync(path.join(deps.directory, 'new.txt'), 'utf8')).toBe('new\n');

    const discarded = response();
    await registry.route('DELETE', '/api/workspaces/exports/:exportID')({ params: { exportID: 'export-1' }, body: { workspaceID: 'workspace-1' } }, discarded);
    expect(discarded.statusCode).toBe(410);
  });

  it('denies artifact download without workspace.admin', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { uiAuthController: { resolveAuthContext: vi.fn(async () => ({ type: 'client', client: { capabilities: ['workspace.read'] } })), consumeReauthProof: vi.fn(async () => true) } } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('GET', '/api/workspaces/exports/:exportID/download')({ params: { exportID: 'export-1' }, query: { workspaceID: 'workspace-1' } }, res);
    expect(res.statusCode).toBe(403);
  });

  it.each([
    ['expired', (directory) => exportArtifact(directory, { expiresAt: new Date(Date.now() - 1).toISOString() }), 410],
    ['mismatched', (directory) => exportArtifact(directory, { projectID: 'other-project' }), 409],
    ['malformed', () => ({ version: 1 }), 400],
  ])('rejects %s operation artifacts', async (_name, createArtifact, status) => {
    const registry = routeRegistry();
    const deps = dependencies({ operations: { exportWorkspace: vi.fn(async () => createArtifact(deps.directory)) } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('GET', '/api/workspaces/:id/export')({ params: { id: 'workspace-1' }, query: { directory: deps.directory } }, res);
    expect(res.statusCode).toBe(status);
  });

  it('ignores provider metadata a caller invents rather than passing it through', async () => {
    // This used to be asserted through the proof binding, which hashed only the fields the
    // route accepts. The proof is gone from validation, so the property is stated where it
    // belongs: whatever else arrives in the body, the operation sees the provider alone.
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const validateRes = response();
    await registry.route('POST', '/api/workspaces/providers/validate')({ method: 'POST', body: { provider: 'docker', policy: 'attacker' }, query: {} }, validateRes);
    expect(validateRes.statusCode).not.toBe(428);
    expect(deps.operations.validateProvider).toHaveBeenCalledWith('docker');
  });

  it('binds workspace settings proof to the complete validated mutation body', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: { sanitizeSettingsUpdate: sanitizeWorkspaceSettingsUpdate } });
    registerWorkspaceRoutes(registry.app, deps);
    const body = { changes: { secureWorkspacesKubernetesIngressNamespaceSelector: '{ "kubernetes.io/metadata.name": "ingress-nginx" }' }, activate: true };
    const res = response();
    await registry.route('POST', '/api/workspaces/settings')({ body }, res);
    expect(deps.uiAuthController.consumeReauthProof).toHaveBeenCalledWith(expect.anything(), {
      operation: 'workspace.configure',
      project: 'host',
      bodyHash: hash(canonical({ activate: true, changes: body.changes })),
    });
    expect(deps.persistSettings).toHaveBeenCalledWith({ secureWorkspacesKubernetesIngressNamespaceSelector: '{"kubernetes.io/metadata.name":"ingress-nginx"}' });
  });

  it('rejects a workspace settings body that does not match the consumed proof', async () => {
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: {
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => ({ type: 'session' })),
        consumeReauthProof: vi.fn(async () => false),
      },
    } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('POST', '/api/workspaces/settings')({ body: { changes: { secureWorkspacesEnabled: true }, activate: false } }, res);
    expect(res.statusCode).toBe(428);
    expect(deps.persistSettings).not.toHaveBeenCalled();
  });

  it('does not ask for the password again to review changes or to apply them', async () => {
    // Nothing this feature contains can reach these routes: the workspace network is
    // created `--internal`, so the runtime has no route to the host, and a tunnel request
    // is refused on scope whatever it presents. What the prompt actually did was
    // interrupt the person already sitting in front of the review screen, often enough
    // that it stopped being read. Authorization still applies; a second credential does
    // not. `consumeReauthProof` refuses everything here, and both routes proceed anyway.
    const registry = routeRegistry();
    const consumeReauthProof = vi.fn(async () => false);
    const deps = dependencies({ dependencies: {
      uiAuthController: { resolveAuthContext: vi.fn(async () => ({ type: 'session' })), consumeReauthProof },
    } });
    registerWorkspaceRoutes(registry.app, deps);

    const review = response();
    await registry.route('GET', '/api/workspaces/:id/export')({ params: { id: 'workspace-1' }, query: { directory: deps.directory } }, review);
    expect(review.statusCode).not.toBe(428);

    const apply = response();
    await registry.route('POST', '/api/workspaces/exports/:exportID/apply')(
      { params: { exportID: 'export-1' }, body: { directory: deps.directory, exportID: 'export-1', selections: [{ fileID: 'file-1' }], workspaceID: 'workspace-1', checkOnly: true } },
      apply,
    );
    expect(apply.statusCode).not.toBe(428);
    expect(consumeReauthProof).not.toHaveBeenCalled();
  });

  it('still asks for the password to change the policy itself', async () => {
    // Every other action states what it will do before doing it. This one takes effect
    // quietly and stays in effect — it can widen the egress allowlist, replace the runtime
    // image, or switch the feature off — so it keeps the bound single-use proof.
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: {
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => ({ type: 'session' })),
        consumeReauthProof: vi.fn(async () => false),
      },
    } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('POST', '/api/workspaces/settings')({ body: { changes: { secureWorkspacesEnabled: true }, activate: false } }, res);
    expect(res.statusCode).toBe(428);
    expect(deps.persistSettings).not.toHaveBeenCalled();
  });

  it('still refuses host administration reaching in over a tunnel', async () => {
    // Removing the prompt must not remove the rule that actually keeps remote callers out.
    const registry = routeRegistry();
    const deps = dependencies({ dependencies: {
      uiAuthController: { resolveAuthContext: vi.fn(async () => ({ type: 'session' })), consumeReauthProof: vi.fn(async () => true) },
      tunnelAuthController: { classifyRequestScope: () => 'tunnel' },
    } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('POST', '/api/workspaces/exports/:exportID/apply')(
      { params: { exportID: 'exp_1' }, body: { directory: '/host/project', selections: [] } },
      res,
    );
    expect(res.statusCode).toBe(403);
  });

  it('registers the plugin at startup when settings enable workspaces and OpenCode has no entry', async () => {
    // The persisted flag and the registration are written together but can drift — an
    // interrupted save, a restored profile, a file edited outside the app. Nothing
    // reconciled them, so the setup step called the feature on while the panel called it
    // unconfigured, and no control repaired either.
    const registry = routeRegistry();
    let pluginEntries = [];
    const deps = dependencies({ dependencies: {
      listPluginEntries: vi.fn(() => pluginEntries),
      createPluginEntry: vi.fn((entry) => { pluginEntries.push({ ...entry, id: 'reconciled' }); }),
    } });
    registerWorkspaceRoutes(registry.app, deps);

    await registry.route('GET', '/api/workspaces/readiness')({ query: {} }, response());

    expect(deps.createPluginEntry).toHaveBeenCalledTimes(1);
    expect(pluginEntries).toEqual([expect.objectContaining({ scope: 'user' })]);
  });

  it('leaves a registration alone when its options already match the policy', async () => {
    const registry = routeRegistry();
    const existing = { id: 'plugin-1', spec: '@openchamber/opencode-container-workspace', scope: 'user', options: reconciledOptions() };
    const deps = dependencies({ dependencies: {
      listPluginEntries: vi.fn(() => [existing]),
      createPluginEntry: vi.fn(),
      deletePluginEntry: vi.fn(),
    } });
    registerWorkspaceRoutes(registry.app, deps);

    await registry.route('GET', '/api/workspaces/readiness')({ query: {} }, response());

    expect(deps.createPluginEntry).not.toHaveBeenCalled();
    expect(deps.deletePluginEntry).not.toHaveBeenCalled();
  });

  it('rewrites a registration whose options fell behind the current policy', async () => {
    // The entry materializes the policy at the moment settings were last saved. A
    // policy default that moved since — a repinned image digest — never reached
    // OpenCode, so every new workspace kept being built from the superseded image
    // while the code pinned the new one. Startup converges the entry.
    const registry = routeRegistry();
    const existing = { id: 'plugin-1', spec: '@openchamber/opencode-container-workspace', scope: 'user', options: { defaultImage: 'registry.example/workspace@sha256:' + 'b'.repeat(64) } };
    let pluginEntries = [existing];
    const deps = dependencies({ dependencies: {
      listPluginEntries: vi.fn(() => pluginEntries),
      deletePluginEntry: vi.fn(() => { pluginEntries = []; }),
      createPluginEntry: vi.fn((entry) => { pluginEntries.push({ ...entry, id: 'rewritten' }); }),
    } });
    registerWorkspaceRoutes(registry.app, deps);

    await registry.route('GET', '/api/workspaces/readiness')({ query: {} }, response());

    expect(deps.deletePluginEntry).toHaveBeenCalledWith('plugin-1', null);
    expect(pluginEntries).toEqual([expect.objectContaining({ scope: 'user', options: reconciledOptions() })]);
  });

  it('rolls persisted settings and plugin configuration back when activation fails', async () => {
    const registry = routeRegistry();
    // Matching options keep startup reconciliation out of this test's way.
    const previousPlugin = { id: 'plugin-1', spec: '@openchamber/opencode-container-workspace', scope: 'user', options: reconciledOptions() };
    let pluginEntries = [previousPlugin];
    const deps = dependencies({ dependencies: {
      listPluginEntries: vi.fn(() => pluginEntries),
      deletePluginEntry: vi.fn(() => { pluginEntries = []; }),
      createPluginEntry: vi.fn((entry) => { pluginEntries.push({ ...entry, id: 'restored' }); }),
      refreshOpenCodeAfterConfigChange: vi.fn(async () => { throw new Error('refresh failed'); }),
    } });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('POST', '/api/workspaces/settings')({ body: { changes: { secureWorkspacesEnabled: false }, activate: true } }, res);
    expect(res.statusCode).toBe(500);
    expect(deps.restoreSettingsFields).toHaveBeenCalledWith(expect.anything(), 'secureWorkspaces');
    expect(pluginEntries).toEqual([expect.objectContaining({ spec: previousPlugin.spec, options: previousPlugin.options })]);
  });

  it('recovers an interrupted workspace settings transaction before serving workspace state', async () => {
    const registry = routeRegistry();
    const openchamberDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-settings-recovery-'));
    const pluginSpec = '/custom/plugin.js';
    const previousPlugin = { spec: pluginSpec, scope: 'user', options: { old: true } };
    let pluginEntries = [{ id: 'partial', spec: pluginSpec, scope: 'user', options: { partial: true } }];
    fs.writeFileSync(path.join(openchamberDataDir, 'workspace-settings-transaction.json'), JSON.stringify({
      version: 1,
      phase: 'prepared',
      pluginSpec,
      previousSettings: { secureWorkspacesEnabled: false },
      previousEntries: [previousPlugin],
    }));
    const deps = dependencies({ dependencies: {
      openchamberDataDir,
      resolveWorkspacePluginSpec: () => pluginSpec,
      listPluginEntries: vi.fn(() => pluginEntries),
      deletePluginEntry: vi.fn((id) => { pluginEntries = pluginEntries.filter((entry) => entry.id !== id); }),
      createPluginEntry: vi.fn((entry) => { pluginEntries.push({ ...entry, id: 'restored' }); }),
    } });

    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('GET', '/api/workspaces/compatibility')({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(deps.restoreSettingsFields).toHaveBeenCalledWith({ secureWorkspacesEnabled: false }, 'secureWorkspaces');
    // Recovery restores the interrupted transaction's exact prior entry first; startup
    // convergence then brings the restored entry to the current policy.
    expect(pluginEntries).toEqual([expect.objectContaining({ spec: pluginSpec, scope: 'user', options: reconciledOptions() })]);
    expect(fs.existsSync(path.join(openchamberDataDir, 'workspace-settings-transaction.json'))).toBe(false);
  });

  it('resolves explicit and packaged plugin paths without provider operations', () => {
    expect(resolveWorkspacePluginSpec({ env: { OPENCHAMBER_WORKSPACE_PLUGIN_PATH: '/custom/plugin.js' } })).toBe('/custom/plugin.js');
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-plugin-'));
    const plugin = path.join(resources, 'opencode-container-workspace', 'src', 'plugin.js');
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, 'export default {}\n');
    const packagedPlugin = path.join(resources, 'app.asar', 'node_modules', 'plugin.js');
    expect(resolveWorkspacePluginSpec({ env: {}, resourcesPath: resources, resolvedSpecUrl: pathToFileURL(packagedPlugin).href })).toBe(plugin);
  });
});
