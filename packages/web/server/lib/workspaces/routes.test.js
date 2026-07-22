import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerWorkspaceRoutes, resolveWorkspacePluginSpec } from './routes.js';
import { sanitizeWorkspaceSettingsUpdate } from './policy.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
const runtimeImage = `registry.example/workspace@sha256:${'a'.repeat(64)}`;

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
  const list = vi.fn(async () => ({ data: [currentWorkspace] }));
  const create = vi.fn(async () => ({ data: currentWorkspace }));
  const status = vi.fn(async () => ({ data: [{ workspaceID: currentWorkspace.id, status: 'connected' }] }));
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
    createOpenCodeClient: vi.fn(() => ({
      experimental: { workspace: {
        list,
        remove,
        create,
        status,
        adapter: { list: vi.fn(async () => ({ data: [], response: { status: 200 } })) },
      } },
    })),
    createWorkspaceProviderOperations,
    uiAuthController: {
      resolveAuthContext: vi.fn(async () => ({ type: 'session', token: 'test-session' })),
      consumeReauthProof: vi.fn(async () => true),
    },
    ...overrides.dependencies,
  };
}

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
      credentials: { modelAuth: 'none' },
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

  it('reconciles provider resources separately from OpenCode sync-list', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();
    await registry.route('POST', '/api/workspaces/:id/reconcile')({ params: { id: 'workspace-1' }, body: { directory: deps.directory } }, res);
    expect(res.body).toEqual({ reconciled: true, status: 'ready', diagnostics: ['resources verified'], remainingResources: [] });
    expect(deps.operations.reconcileWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'workspace-1' }));
    expect(deps.uiAuthController.consumeReauthProof).toHaveBeenCalledWith(expect.anything(), {
      operation: 'workspace.reconcile', project: deps.directory, bodyHash: hash(canonical({ id: 'workspace-1', directory: deps.directory })),
    });
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

  it('does not accept a recovered ID mismatch without verified operations adoption', async () => {
    const recovered = workspace('/unused');
    recovered.id = 'forged-id';
    recovered.extra.controlPlaneWorkspaceID = 'original-id';
    const registry = routeRegistry();
    const deps = dependencies({ workspace: recovered });
    registerWorkspaceRoutes(registry.app, deps);
    const res = response();

    await registry.route('DELETE', '/api/workspaces/:id')({ params: { id: 'forged-id' }, body: { directory: deps.directory }, query: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(deps.operations.cleanupWorkspace).not.toHaveBeenCalled();
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

  it('preserves exact auth bindings for ignored provider metadata and structured apply selections', async () => {
    const registry = routeRegistry();
    const deps = dependencies();
    registerWorkspaceRoutes(registry.app, deps);
    const validateRes = response();
    await registry.route('POST', '/api/workspaces/providers/validate')({ method: 'POST', body: { provider: 'docker', policy: 'attacker' }, query: {} }, validateRes);
    expect(deps.uiAuthController.consumeReauthProof).toHaveBeenNthCalledWith(1, expect.anything(), {
      operation: 'workspace.validate', project: 'host', bodyHash: hash(JSON.stringify({ provider: 'docker' })),
    });

    const exportRes = response();
    await registry.route('GET', '/api/workspaces/:id/export')({ params: { id: 'workspace-1' }, query: { directory: deps.directory } }, exportRes);
    const applyBody = { directory: deps.directory, exportID: 'export-1', selections: [{ fileID: 'file-1' }], workspaceID: 'workspace-1', checkOnly: true };
    const applyRes = response();
    await registry.route('POST', '/api/workspaces/exports/:exportID/apply')({ params: { exportID: 'export-1' }, body: applyBody }, applyRes);
    expect(deps.uiAuthController.consumeReauthProof).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'host.apply', project: deps.directory, bodyHash: hash(canonical(applyBody)),
    });
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

  it('rolls persisted settings and plugin configuration back when activation fails', async () => {
    const registry = routeRegistry();
    const previousPlugin = { id: 'plugin-1', spec: '@openchamber/opencode-container-workspace', scope: 'user', options: { old: true } };
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
    expect(pluginEntries).toEqual([{ ...previousPlugin, id: 'restored' }]);
    expect(fs.existsSync(path.join(openchamberDataDir, 'workspace-settings-transaction.json'))).toBe(false);
  });

  it('resolves explicit and packaged plugin paths without provider operations', () => {
    expect(resolveWorkspacePluginSpec({ env: { OPENCHAMBER_WORKSPACE_PLUGIN_PATH: '/custom/plugin.js' } })).toBe('/custom/plugin.js');
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-plugin-'));
    const plugin = path.join(resources, 'opencode-container-workspace', 'src', 'plugin.js');
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, 'export default {}\n');
    expect(resolveWorkspacePluginSpec({ env: {}, resourcesPath: resources, resolvedSpecUrl: 'file:///Applications/OpenChamber.app/Contents/Resources/app.asar/node_modules/plugin.js' })).toBe(plugin);
  });
});
