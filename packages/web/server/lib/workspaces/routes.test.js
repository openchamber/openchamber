import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalWorkspaceLabelID } from '@openchamber/opencode-container-workspace/label-id';
import { SECURE_APPLE_CONTAINER_NETWORK, SECURE_DOCKER_NETWORK } from '@openchamber/opencode-container-workspace/policy';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.fn();

const { registerWorkspaceRoutes, resolveWorkspacePluginSpec } = await import('./routes.js');
const originalFetch = globalThis.fetch;

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const createChild = ({ stdout = '', stderr = '', code = 0 } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  setTimeout(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  }, 0);
  return child;
};

const createDependencies = (overrides = {}) => ({
  validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
  readSettingsFromDiskMigrated: vi.fn(async () => ({ secureWorkspacesEnabled: true })),
  refreshOpenCodeAfterConfigChange: vi.fn(async () => undefined),
  listPluginEntries: vi.fn(() => []),
  createPluginEntry: vi.fn(),
  updatePluginEntry: vi.fn(),
  deletePluginEntry: vi.fn(),
  buildOpenCodeUrl: vi.fn((route) => `http://opencode.test${route}`),
  getOpenCodeAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test' })),
  spawn: spawnMock,
  ...overrides,
});

describe('workspace routes', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('configures OpenCode with an absolute installed plugin path', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      workspacePluginSpec: '/real/plugin/src/plugin.js',
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        secureWorkspacesEnabled: true,
        secureWorkspacesDefaultProvider: 'docker',
        secureWorkspacesImage: 'ghcr.io/openchamber/opencode-workspace:1.0.0',
        secureWorkspacesEgressHttpProxy: 'http://proxy.openchamber:3128',
        secureWorkspacesEgressNoProxy: '127.0.0.1,localhost',
      })),
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/configure')({}, res);

    expect(res.statusCode).toBe(200);
    expect(deps.createPluginEntry).toHaveBeenCalledTimes(1);
    const entry = deps.createPluginEntry.mock.calls[0][0];
    expect(path.isAbsolute(entry.spec)).toBe(true);
    expect(entry.spec).toBe('/real/plugin/src/plugin.js');
    expect(entry.options.defaultProvider).toBe('docker');
    expect(entry.options.docker).toEqual({ networkMode: SECURE_DOCKER_NETWORK, allowedNetworks: [] });
    expect(entry.options.appleContainer).toEqual({ networkMode: SECURE_APPLE_CONTAINER_NETWORK });
    expect(entry.options.kubernetes.networkPolicy).toBe('default-deny');
    expect(entry.options.egress).toEqual({
      httpProxy: 'http://proxy.openchamber:3128',
      proxyCIDR: undefined,
      dnsCIDRs: [],
      noProxy: '127.0.0.1,localhost',
    });
    expect(deps.refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  it('activates configured workspace providers only when requested', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      workspacePluginSpec: '/real/plugin/src/plugin.js',
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        secureWorkspacesEnabled: true,
        secureWorkspacesDefaultProvider: 'docker',
        secureWorkspacesEgressHttpProxy: 'http://proxy.openchamber:3128',
      })),
      refreshOpenCodeAfterConfigChange: vi.fn(async () => ({ reloaded: true, external: false })),
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ kind: 'docker' }, { kind: 'kubernetes' }],
    }));
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/configure')({ body: { activate: true } }, res);

    expect(res.statusCode).toBe(200);
    expect(deps.refreshOpenCodeAfterConfigChange).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ configured: true, enabled: true, activated: true, active: true, external: false });
  });

  it('reports external activation as manual restart required when adapters are still inactive', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      workspacePluginSpec: '/real/plugin/src/plugin.js',
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        secureWorkspacesEnabled: true,
        secureWorkspacesDefaultProvider: 'docker',
        secureWorkspacesEgressHttpProxy: 'http://proxy.openchamber:3128',
      })),
      refreshOpenCodeAfterConfigChange: vi.fn(async () => ({ reloaded: false, external: true })),
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/configure')({ body: { activate: true } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ active: false, external: true, manualRestartRequired: true });
  });

  it('probes workspace compatibility without mutating plugin config', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      workspacePluginSpec: '/real/plugin/src/plugin.js',
      listPluginEntries: vi.fn(() => [{ id: 'plugin-1', spec: '/real/plugin/src/plugin.js' }]),
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ kind: 'docker' }] }));
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/compatibility')({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ configured: true, active: true, supported: true, adapterKinds: ['docker'] });
    expect(deps.createPluginEntry).not.toHaveBeenCalled();
  });

  it('treats Apple Container adapters as active secure workspace support', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      workspacePluginSpec: '/real/plugin/src/plugin.js',
      listPluginEntries: vi.fn(() => [{ id: 'plugin-1', spec: '/real/plugin/src/plugin.js' }]),
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ kind: 'apple-container' }] }));
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/compatibility')({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ configured: true, active: true, supported: true, adapterKinds: ['apple-container'] });
  });

  it('bounds workspace compatibility adapter probes', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({ workspacePluginSpec: '/real/plugin/src/plugin.js' });
    globalThis.fetch = vi.fn(async (_url, options) => {
      options.signal.dispatchEvent(new Event('abort'));
      throw new DOMException('aborted', 'AbortError');
    });
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/compatibility')({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ active: false, supported: true, status: 'not-configured' });
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('reports missing Docker egress during provider validation', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      readSettingsFromDiskMigrated: vi.fn(async () => ({ secureWorkspacesEnabled: true })),
    });
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/providers/validate')({ query: { provider: 'docker' } }, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ available: false });
    expect(res.body.error).toContain('egress HTTP proxy');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports missing Kubernetes egress during provider validation before kubectl checks', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        secureWorkspacesEnabled: true,
        secureWorkspacesEgressHttpProxy: 'http://proxy.openchamber:3128',
      })),
    });
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/providers/validate')({ query: { provider: 'kubernetes' } }, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ available: false });
    expect(res.body.error).toContain('proxy CIDR');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('validates providers from POST body without putting proxy settings in the query string', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    spawnMock
      .mockReturnValueOnce(createChild())
      .mockReturnValueOnce(createChild({ stdout: '25.0.0\n' }));

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/providers/validate')({
      method: 'POST',
      body: { provider: 'docker', egressHttpProxy: 'http://proxy.openchamber:3128' },
      query: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('configures Apple Container as the default provider with explicit egress', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      workspacePluginSpec: '/real/plugin/src/plugin.js',
      readSettingsFromDiskMigrated: vi.fn(async () => ({
        secureWorkspacesEnabled: true,
        secureWorkspacesDefaultProvider: 'apple-container',
        secureWorkspacesImage: 'ghcr.io/openchamber/opencode-workspace:1.0.0',
        secureWorkspacesEgressHttpProxy: 'http://127.0.0.1:3128',
        secureWorkspacesEgressNoProxy: '127.0.0.1,localhost',
      })),
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ kind: 'apple-container' }] }));
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/configure')({ body: {} }, res);

    expect(res.statusCode).toBe(200);
    const entry = deps.createPluginEntry.mock.calls[0][0];
    expect(entry.options.defaultProvider).toBe('apple-container');
    expect(entry.options.appleContainer).toEqual({ networkMode: SECURE_APPLE_CONTAINER_NETWORK });
  });

  it('rejects egress proxy URLs with embedded credentials', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/providers/validate')({
      method: 'POST',
      body: { provider: 'docker', egressHttpProxy: 'http://user:password@proxy.openchamber:3128' },
      query: {},
    }, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toContain('must not include credentials');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects invalid Kubernetes egress CIDRs before kubectl checks', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/providers/validate')({
      method: 'POST',
      body: {
        provider: 'kubernetes',
        egressHttpProxy: 'http://proxy.openchamber:3128',
        egressProxyCIDR: 'not-a-cidr',
        egressDnsCIDRs: '10.0.0.53/32',
      },
      query: {},
    }, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toContain('valid IPv4 or IPv6 CIDR');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('disables secure workspaces without resolving a missing plugin path', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({
      readSettingsFromDiskMigrated: vi.fn(async () => ({ secureWorkspacesEnabled: false })),
      resolveWorkspacePluginSpec: vi.fn(() => {
        throw new Error('plugin resource missing');
      }),
      listPluginEntries: vi.fn(() => [{
        id: 'plugin-1',
        spec: '/Applications/OpenChamber.app/Contents/Resources/app.asar/node_modules/@openchamber/opencode-container-workspace/src/plugin.js',
      }]),
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/configure')({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ configured: false, enabled: false, active: false, activated: false });
    expect(deps.resolveWorkspacePluginSpec).not.toHaveBeenCalled();
    expect(deps.deletePluginEntry).toHaveBeenCalledWith('plugin-1', null);
  });

  it('resolves an explicit plugin path override before module resolution', () => {
    expect(resolveWorkspacePluginSpec({
      env: { OPENCHAMBER_WORKSPACE_PLUGIN_PATH: '/custom/plugin.js' },
      resolvedSpecUrl: 'file:///app/app.asar/node_modules/@openchamber/opencode-container-workspace/src/plugin.js',
    })).toBe('/custom/plugin.js');
  });

  it('resolves app.asar plugin paths to unpacked Electron resources', () => {
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-workspaces-'));
    const pluginPath = path.join(resourcesDir, 'opencode-container-workspace', 'src', 'plugin.js');
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, 'export default {}\n');
    try {
      const resolved = resolveWorkspacePluginSpec({
        env: {},
        resourcesPath: resourcesDir,
        resolvedSpecUrl: 'file:///Applications/OpenChamber.app/Contents/Resources/app.asar/node_modules/@openchamber/opencode-container-workspace/src/plugin.js',
      });
      expect(resolved).toBe(pluginPath);
    } finally {
      fs.rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it('exports docker diffs with a temporary index that includes untracked files', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    const workspaceID = 'ws_1';
    const labelID = canonicalWorkspaceLabelID(workspaceID);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: workspaceID,
        extra: {
          provider: 'docker',
          runtime: { container: 'openchamber-ws-1' },
          labels: {
            'openchamber.managed': 'true',
            'openchamber.workspace.provider': 'docker',
            'openchamber.workspace.id': labelID,
          },
        },
      }],
    }));
    spawnMock
      .mockReturnValueOnce(createChild({ stdout: JSON.stringify([{ Config: { Labels: { 'openchamber.managed': 'true', 'openchamber.workspace.provider': 'docker', 'openchamber.workspace.id': labelID } } }]) }))
      .mockReturnValueOnce(createChild({ stdout: 'diff --git a/new.txt b/new.txt\n' }));

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: workspaceID }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.patch).toContain('diff --git');
    const [, args] = spawnMock.mock.calls[1];
    const script = args.at(-1);
    expect(script).toContain('GIT_INDEX_FILE="$tmp" git add -N .');
    expect(script).toContain('git diff --binary HEAD');
  });

  it('exports docker diffs when the workspace ID requires label normalization', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    const workspaceID = 'ws:1/abc';
    const labelID = canonicalWorkspaceLabelID(workspaceID);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: workspaceID,
        extra: {
          provider: 'docker',
          runtime: { container: 'openchamber-ws-1' },
          labels: {
            'openchamber.managed': 'true',
            'openchamber.workspace.provider': 'docker',
            'openchamber.workspace.id': labelID,
          },
        },
      }],
    }));
    spawnMock
      .mockReturnValueOnce(createChild({ stdout: JSON.stringify([{ Config: { Labels: { 'openchamber.managed': 'true', 'openchamber.workspace.provider': 'docker', 'openchamber.workspace.id': labelID } } }]) }))
      .mockReturnValueOnce(createChild({ stdout: 'diff --git a/new.txt b/new.txt\n' }));

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: workspaceID }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.patch).toContain('diff --git');
  });

  it.each(['ws_1', 'ws:1/abc'])('exports kubernetes diffs for workspace ID %s using canonical labels', async (workspaceID) => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    const labelID = canonicalWorkspaceLabelID(workspaceID);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: workspaceID,
        extra: {
          provider: 'kubernetes',
          runtime: { deployment: 'openchamber-ws-1', namespace: 'openchamber-workspaces' },
          labels: {
            'openchamber.io/managed': 'true',
            'openchamber.io/provider': 'kubernetes',
            'openchamber.io/workspace-id': labelID,
          },
        },
      }],
    }));
    spawnMock
      .mockReturnValueOnce(createChild({ stdout: JSON.stringify({ metadata: { labels: { 'openchamber.io/managed': 'true', 'openchamber.io/provider': 'kubernetes', 'openchamber.io/workspace-id': labelID } } }) }))
      .mockReturnValueOnce(createChild({ stdout: 'diff --git a/new.txt b/new.txt\n' }));

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: workspaceID }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ patch: 'diff --git a/new.txt b/new.txt\n', provider: 'kubernetes' });
    expect(res.body.exportID).toEqual(expect.any(String));
    expect(res.body.summary.files[0]).toMatchObject({ path: 'new.txt' });
  });

  it.each(['ws_1', 'ws:1/abc'])('exports Apple Container diffs for workspace ID %s using canonical labels', async (workspaceID) => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    const labelID = canonicalWorkspaceLabelID(workspaceID);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: workspaceID,
        extra: {
          provider: 'apple-container',
          runtime: { container: 'openchamber-ws-1' },
          policy: { appleContainer: { cli: '/usr/local/bin/container' } },
          labels: {
            'openchamber.managed': 'true',
            'openchamber.workspace.provider': 'apple-container',
            'openchamber.workspace.id': labelID,
          },
        },
      }],
    }));
    spawnMock
      .mockReturnValueOnce(createChild({ stdout: JSON.stringify([{ configuration: { labels: { 'openchamber.managed': 'true', 'openchamber.workspace.provider': 'apple-container', 'openchamber.workspace.id': labelID } } }]) }))
      .mockReturnValueOnce(createChild({ stdout: 'diff --git a/new.txt b/new.txt\n' }));

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: workspaceID }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ patch: 'diff --git a/new.txt b/new.txt\n', provider: 'apple-container' });
    expect(spawnMock.mock.calls[0][0]).toBe('/usr/local/bin/container');
    expect(spawnMock.mock.calls[1][1]).toEqual(['exec', 'openchamber-ws-1', 'sh', '-lc', expect.stringContaining('git diff --binary HEAD')]);
  });

  it('rejects docker export when workspace metadata is missing managed ownership labels', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: 'ws-1',
        extra: {
          provider: 'docker',
          runtime: { container: 'openchamber-ws-1' },
          labels: {
            'openchamber.managed': 'true',
            'openchamber.workspace.provider': 'docker',
          },
        },
      }],
    }));

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: 'ws-1' }, query: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('missing required managed label');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects docker export when provider resource labels do not match workspace metadata', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: 'ws-1',
        extra: {
          provider: 'docker',
          runtime: { container: 'openchamber-ws-1' },
          labels: {
            'openchamber.managed': 'true',
            'openchamber.workspace.provider': 'docker',
            'openchamber.workspace.id': 'ws-1',
          },
        },
      }],
    }));
    spawnMock.mockReturnValueOnce(createChild({ stdout: JSON.stringify([{ Config: { Labels: { 'openchamber.managed': 'true', 'openchamber.workspace.provider': 'docker', 'openchamber.workspace.id': 'different' } } }]) }));

    const res = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: 'ws-1' }, query: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('label mismatch');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('returns apply check failures as conflicts without applying the patch', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    spawnMock.mockReturnValue(createChild({ stderr: 'patch does not apply', code: 1 }));

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/export/apply')({
      body: { directory: '/repo', patch: 'diff --git a/a b/a\n', checkOnly: false },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.applied).toBe(false);
    expect(res.body.error).toContain('patch does not apply');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('checks then applies when patch validation succeeds and checkOnly is false', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    spawnMock.mockImplementation(() => createChild());

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/export/apply')({
      body: { directory: '/repo', patch: 'diff --git a/a b/a\n', checkOnly: false },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toEqual(['apply', '--check', '-']);
    expect(spawnMock.mock.calls[1][1]).toEqual(['apply', '-']);
  });

  it('applies only selected exported file sections with one combined git apply', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    const workspaceID = 'ws-1';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: workspaceID,
        extra: {
          provider: 'docker',
          runtime: { container: 'openchamber-ws-1' },
          labels: {
            'openchamber.managed': 'true',
            'openchamber.workspace.provider': 'docker',
            'openchamber.workspace.id': workspaceID,
          },
        },
      }],
    }));
    const patch = [
      'diff --git a/a.txt b/a.txt\n',
      '--- a/a.txt\n',
      '+++ b/a.txt\n',
      '@@ -1 +1 @@\n',
      '-old\n',
      '+new\n',
      'diff --git a/b.txt b/b.txt\n',
      '--- a/b.txt\n',
      '+++ b/b.txt\n',
      '@@ -1 +1 @@\n',
      '-left\n',
      '+right\n',
    ].join('');
    spawnMock
      .mockReturnValueOnce(createChild({ stdout: JSON.stringify([{ Config: { Labels: { 'openchamber.managed': 'true', 'openchamber.workspace.provider': 'docker', 'openchamber.workspace.id': workspaceID } } }]) }))
      .mockReturnValueOnce(createChild({ stdout: patch }))
      .mockImplementation(() => createChild());

    const exportRes = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: workspaceID }, query: { directory: '/repo' } }, exportRes);
    const firstFileID = exportRes.body.summary.files[0].id;

    const applyRes = createMockResponse();
    await getRoute('POST', '/api/workspaces/exports/:exportID/apply')({
      params: { exportID: exportRes.body.exportID },
      body: { directory: '/repo', workspaceID, fileIDs: [firstFileID], checkOnly: false },
    }, applyRes);

    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.body.summary.files).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(spawnMock.mock.results[2].value.stdin.end).toHaveBeenCalledWith(expect.stringContaining('diff --git a/a.txt b/a.txt'));
    expect(spawnMock.mock.results[2].value.stdin.end).toHaveBeenCalledWith(expect.not.stringContaining('diff --git a/b.txt b/b.txt'));
    expect(spawnMock.mock.calls[2][1]).toEqual(['apply', '--check', '-']);
    expect(spawnMock.mock.calls[3][1]).toEqual(['apply', '-']);
  });

  it('rejects selected apply when the target directory differs from the exported directory', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    const workspaceID = 'ws-1';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: workspaceID,
        extra: {
          provider: 'docker',
          runtime: { container: 'openchamber-ws-1' },
          labels: {
            'openchamber.managed': 'true',
            'openchamber.workspace.provider': 'docker',
            'openchamber.workspace.id': workspaceID,
          },
        },
      }],
    }));
    spawnMock
      .mockReturnValueOnce(createChild({ stdout: JSON.stringify([{ Config: { Labels: { 'openchamber.managed': 'true', 'openchamber.workspace.provider': 'docker', 'openchamber.workspace.id': workspaceID } } }]) }))
      .mockReturnValueOnce(createChild({ stdout: 'diff --git a/a.txt b/a.txt\n' }));

    const exportRes = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: workspaceID }, query: { directory: '/repo-a' } }, exportRes);

    const applyRes = createMockResponse();
    await getRoute('POST', '/api/workspaces/exports/:exportID/apply')({
      params: { exportID: exportRes.body.exportID },
      body: { directory: '/repo-b', workspaceID, fileIDs: [exportRes.body.summary.files[0].id], checkOnly: true },
    }, applyRes);

    expect(applyRes.statusCode).toBe(409);
    expect(applyRes.body.error).toContain('target directory');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('rejects selected apply when the selected workspace differs from the exported workspace', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies();
    registerWorkspaceRoutes(app, deps);
    const workspaceID = 'ws-1';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        id: workspaceID,
        extra: {
          provider: 'docker',
          runtime: { container: 'openchamber-ws-1' },
          labels: {
            'openchamber.managed': 'true',
            'openchamber.workspace.provider': 'docker',
            'openchamber.workspace.id': workspaceID,
          },
        },
      }],
    }));
    spawnMock
      .mockReturnValueOnce(createChild({ stdout: JSON.stringify([{ Config: { Labels: { 'openchamber.managed': 'true', 'openchamber.workspace.provider': 'docker', 'openchamber.workspace.id': workspaceID } } }]) }))
      .mockReturnValueOnce(createChild({ stdout: 'diff --git a/a.txt b/a.txt\n' }));

    const exportRes = createMockResponse();
    await getRoute('GET', '/api/workspaces/:id/export-diff')({ params: { id: workspaceID }, query: { directory: '/repo' } }, exportRes);

    const applyRes = createMockResponse();
    await getRoute('POST', '/api/workspaces/exports/:exportID/apply')({
      params: { exportID: exportRes.body.exportID },
      body: { directory: '/repo', workspaceID: 'ws-2', fileIDs: [exportRes.body.summary.files[0].id], checkOnly: true },
    }, applyRes);

    expect(applyRes.statusCode).toBe(409);
    expect(applyRes.body.error).toContain('selected workspace');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('returns 410 when a selected export artifact has expired', async () => {
    const { app, getRoute } = createRouteRegistry();
    const deps = createDependencies({ exportArtifactCache: { get: vi.fn(() => null) } });
    registerWorkspaceRoutes(app, deps);

    const res = createMockResponse();
    await getRoute('POST', '/api/workspaces/exports/:exportID/apply')({
      params: { exportID: 'expired' },
      body: { directory: '/repo', fileIDs: ['file'], checkOnly: true },
    }, res);

    expect(res.statusCode).toBe(410);
    expect(res.body.error).toContain('expired');
  });
});
