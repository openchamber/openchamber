import { describe, expect, it } from 'bun:test';
import { createTunnelRoutesRuntime } from './routes.js';
import {
  isSupportedTunnelMode,
  normalizeTunnelMode,
  normalizeTunnelProvider,
  normalizeTunnelStartRequest,
  validateTunnelStartRequest,
  TUNNEL_MODE_PRIVATE_NETWORK,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_TAILSCALE,
  TunnelServiceError,
} from './types.js';

describe('public tunnel password requirement', () => {
  const createRuntime = (hasUiPassword) => {
    let starts = 0;
    const runtime = createTunnelRoutesRuntime({
      hasUiPassword,
      tunnelService: {
        start: async () => {
          starts += 1;
          return { provider: 'cloudflare', publicUrl: 'https://example.com', activeMode: 'quick' };
        },
      },
      TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare',
      TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    });
    return { runtime, getStarts: () => starts };
  };

  it('rejects an unauthenticated runtime before starting any provider', async () => {
    const { runtime, getStarts } = createRuntime(false);
    await expect(runtime.startTunnelWithNormalizedRequest({ provider: 'cloudflare', mode: 'quick' }))
      .rejects.toThrow('A UI password is required');
    expect(getStarts()).toBe(0);
  });

  it('rejects the HTTP start route without disturbing an existing tunnel', async () => {
    const { runtime, getStarts } = createRuntime(false);
    const routes = new Map();
    const app = {
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
      put: (path, handler) => routes.set(`PUT ${path}`, handler),
    };
    runtime.registerRoutes(app);
    let status = 200;
    let body;
    const response = {
      status(code) { status = code; return this; },
      json(payload) { body = payload; return this; },
    };
    await routes.get('POST /api/openchamber/tunnel/start')({ body: {} }, response);
    expect(status).toBe(403);
    expect(body.code).toBe('ui_password_required');
    expect(getStarts()).toBe(0);
  });

  it('refuses every tunnel in enterprise mode, password or not', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const { runtime, getStarts } = createRuntime(true);
      await expect(runtime.startTunnelWithNormalizedRequest({ provider: 'cloudflare', mode: 'quick' }))
        .rejects.toThrow('enterprise mode');
      const routes = new Map();
      runtime.registerRoutes({
        get: (path, handler) => routes.set(`GET ${path}`, handler),
        post: (path, handler) => routes.set(`POST ${path}`, handler),
        put: (path, handler) => routes.set(`PUT ${path}`, handler),
      });
      let status = 200;
      let body;
      await routes.get('POST /api/openchamber/tunnel/start')({ body: {} }, {
        status(code) { status = code; return this; },
        json(payload) { body = payload; return this; },
      });
      expect(status).toBe(403);
      expect(body.code).toBe('enterprise_mode');
      expect(getStarts()).toBe(0);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('allows a password-protected runtime to start a tunnel', async () => {
    const { runtime, getStarts } = createRuntime(true);
    const result = await runtime.startTunnelWithNormalizedRequest({ provider: 'cloudflare', mode: 'quick' });
    expect(result.publicUrl).toBe('https://example.com');
    expect(getStarts()).toBe(1);
  });
});

const createApp = () => {
  const routes = new Map();
  const register = (method, path, handler) => routes.set(`${method} ${path}`, handler);
  return {
    get: (path, handler) => register('GET', path, handler),
    post: (path, handler) => register('POST', path, handler),
    put: (path, handler) => register('PUT', path, handler),
    routes,
  };
};

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return body;
  },
});

const createRouteHarness = ({
  settings,
  activeProvider = null,
  activeMode = null,
  publicUrl = null,
  authMode = null,
  authHost = null,
  authId = null,
  activeController = null,
} = {}) => {
  const app = createApp();
  const state = {
    authHost,
    authId,
    authMode,
    startedRequest: null,
    controller: activeController,
    stopCalls: 0,
  };
  const providers = {
    [TUNNEL_PROVIDER_CLOUDFLARE]: { capabilities: { defaults: { mode: TUNNEL_MODE_QUICK } } },
    [TUNNEL_PROVIDER_TAILSCALE]: { capabilities: { defaults: { mode: TUNNEL_MODE_PRIVATE_NETWORK } } },
  };
  const tunnelAuthController = {
    getActiveTunnelId: () => state.authId,
    getActiveTunnelMode: () => state.authMode,
    getActiveTunnelHost: () => state.authHost,
    setActiveTunnel: ({ tunnelId, publicUrl: nextUrl, mode }) => {
      state.authId = tunnelId;
      state.authHost = new URL(nextUrl).hostname;
      state.authMode = mode;
    },
    issueBootstrapToken: () => ({ token: 'bootstrap-token', expiresAt: 123 }),
    getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
    revokeActiveTunnel: () => 0,
    invalidateAllTunnelSessions: () => 0,
    revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
    clearActiveTunnel: () => {
      state.authId = null;
      state.authHost = null;
      state.authMode = null;
    },
    listTunnelSessions: () => [],
  };
  const tunnelService = {
    resolveActiveProvider: () => activeProvider,
    resolveActiveMode: () => activeMode,
    getPublicUrl: () => publicUrl,
    start: async (request) => {
      if (request.provider === TUNNEL_PROVIDER_TAILSCALE) {
        const normalizedRequest = normalizeTunnelStartRequest(request);
        validateTunnelStartRequest(normalizedRequest, {
          provider: TUNNEL_PROVIDER_TAILSCALE,
          modes: [{ key: normalizedRequest.mode, intent: normalizedRequest.intent }],
        });
      }
      state.startedRequest = request;
      const nextUrl = request.provider === TUNNEL_PROVIDER_TAILSCALE
        ? 'https://machine.tailnet.ts.net'
        : 'https://demo.example.ts.net';
      const controller = {
        mode: request.mode,
        provider: request.provider,
        tailscaleHttpsPort: request.tailscaleHttpsPort,
        getPublicUrl: () => nextUrl,
      };
      state.controller = controller;
      return {
        provider: request.provider,
        activeMode: request.mode,
        publicUrl: nextUrl,
      };
    },
    stop: () => {
      state.stopCalls += 1;
      state.controller?.stop?.();
      state.controller = null;
    },
    checkAvailability: async () => ({ available: true }),
    getProviderMetadata: () => null,
  };
  const dependencies = {
    crypto: { randomUUID: () => 'tunnel-id' },
    URL,
    tunnelService,
    tunnelProviderRegistry: {
      get: (provider) => providers[provider] ?? null,
      listCapabilities: () => Object.values(providers).map(({ capabilities }) => capabilities),
    },
    tunnelAuthController,
    hasUiPassword: true,
    readSettingsFromDiskMigrated: async () => settings ?? {},
    readManagedRemoteTunnelConfigFromDisk: async () => ({ tunnels: [] }),
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath: (value) => (value && String(value).trim() ? String(value).trim() : undefined),
    normalizeManagedRemoteTunnelHostname: (value) => (value && String(value).trim()
      ? String(value).trim().toLowerCase()
      : null),
    normalizeTunnelBootstrapTtlMs: (value) => value ?? 1000,
    normalizeTunnelSessionTtlMs: (value) => value ?? 2000,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken: async () => {},
    resolveManagedRemoteTunnelToken: async () => '',
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_PRIVATE_NETWORK,
    TUNNEL_MODE_MANAGED_LOCAL: 'managed-local',
    TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    TUNNEL_PROVIDER_CLOUDFLARE,
    TUNNEL_PROVIDER_TAILSCALE,
    TunnelServiceError,
    getActivePort: () => 3000,
    getRuntimeManagedRemoteTunnelHostname: () => null,
    setRuntimeManagedRemoteTunnelHostname: () => {},
    getRuntimeManagedRemoteTunnelToken: () => '',
    setRuntimeManagedRemoteTunnelToken: () => {},
    getActiveTunnelController: () => state.controller,
    setActiveTunnelController: (controller) => {
      state.controller = controller;
    },
  };

  createTunnelRoutesRuntime(dependencies).registerRoutes(app);
  return { app, state };
};

describe('tunnel route mode reconciliation', () => {
  it('keeps a running Tailscale Serve tunnel private-network in status and auth metadata', async () => {
    const { app, state } = createRouteHarness({
      settings: { tunnelProvider: TUNNEL_PROVIDER_TAILSCALE, tunnelMode: TUNNEL_MODE_PRIVATE_NETWORK },
      activeProvider: TUNNEL_PROVIDER_TAILSCALE,
      activeMode: TUNNEL_MODE_PRIVATE_NETWORK,
      publicUrl: 'https://machine.tailnet.ts.net',
      authId: 'active-id',
      authMode: TUNNEL_MODE_QUICK,
      authHost: 'machine.tailnet.ts.net',
    });

    const response = createResponse();
    await app.routes.get('GET /api/openchamber/tunnel/status')({}, response);

    expect(response.body.active).toBe(true);
    expect(response.body.provider).toBe(TUNNEL_PROVIDER_TAILSCALE);
    expect(response.body.mode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
    expect(response.body.activeTunnelMode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
    expect(state.authMode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
  });
});

describe('tunnel start route provider defaults', () => {
  it('uses Tailscale private-network when switching from persisted Cloudflare quick mode', async () => {
    const { app, state } = createRouteHarness({
      settings: { tunnelProvider: TUNNEL_PROVIDER_CLOUDFLARE, tunnelMode: TUNNEL_MODE_QUICK },
      activeProvider: TUNNEL_PROVIDER_CLOUDFLARE,
      publicUrl: 'https://old.example.ts.net',
    });
    const response = createResponse();
    await app.routes.get('POST /api/openchamber/tunnel/start')({ body: { provider: TUNNEL_PROVIDER_TAILSCALE } }, response);

    expect(state.startedRequest.mode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
    expect(response.body.mode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
    expect(state.authMode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
  });

  it('preserves an explicit mode and same-provider persisted mode', async () => {
    const explicit = createRouteHarness({
      settings: { tunnelProvider: TUNNEL_PROVIDER_CLOUDFLARE, tunnelMode: TUNNEL_MODE_QUICK },
      activeProvider: TUNNEL_PROVIDER_CLOUDFLARE,
    });
    const explicitResponse = createResponse();
    await explicit.app.routes.get('POST /api/openchamber/tunnel/start')({
      body: { provider: TUNNEL_PROVIDER_TAILSCALE, mode: TUNNEL_MODE_QUICK },
    }, explicitResponse);

    const sameProvider = createRouteHarness({
      settings: { tunnelProvider: TUNNEL_PROVIDER_TAILSCALE, tunnelMode: TUNNEL_MODE_QUICK },
      activeProvider: TUNNEL_PROVIDER_TAILSCALE,
    });
    const sameProviderResponse = createResponse();
    await sameProvider.app.routes.get('POST /api/openchamber/tunnel/start')({
      body: { provider: TUNNEL_PROVIDER_TAILSCALE },
    }, sameProviderResponse);

    expect(explicit.state.startedRequest.mode).toBe(TUNNEL_MODE_QUICK);
    expect(sameProvider.state.startedRequest.mode).toBe(TUNNEL_MODE_QUICK);
  });

  it('forwards explicit Tailscale HTTPS ports over persisted settings', async () => {
    const persisted = createRouteHarness({
      settings: {
        tunnelProvider: TUNNEL_PROVIDER_TAILSCALE,
        tunnelMode: TUNNEL_MODE_PRIVATE_NETWORK,
        tailscaleHttpsPort: 9443,
      },
      activeProvider: TUNNEL_PROVIDER_TAILSCALE,
    });
    const persistedResponse = createResponse();
    await persisted.app.routes.get('POST /api/openchamber/tunnel/start')({ body: { provider: TUNNEL_PROVIDER_TAILSCALE } }, persistedResponse);

    const explicit = createRouteHarness({
      settings: {
        tunnelProvider: TUNNEL_PROVIDER_TAILSCALE,
        tunnelMode: TUNNEL_MODE_PRIVATE_NETWORK,
        tailscaleHttpsPort: 8443,
      },
      activeProvider: TUNNEL_PROVIDER_TAILSCALE,
    });
    const explicitResponse = createResponse();
    await explicit.app.routes.get('POST /api/openchamber/tunnel/start')({
      body: { provider: TUNNEL_PROVIDER_TAILSCALE, tailscaleHttpsPort: '10000' },
    }, explicitResponse);

    expect(persisted.state.startedRequest.tailscaleHttpsPort).toBe(9443);
    expect(explicit.state.startedRequest.tailscaleHttpsPort).toBe('10000');
  });

  it('preserves an active Tailscale tunnel after an invalid replacement start', async () => {
    const controller = { stopped: false, stop() { this.stopped = true; } };
    const { app, state } = createRouteHarness({
      settings: { tunnelProvider: TUNNEL_PROVIDER_TAILSCALE, tunnelMode: TUNNEL_MODE_PRIVATE_NETWORK },
      activeProvider: TUNNEL_PROVIDER_TAILSCALE,
      activeMode: TUNNEL_MODE_PRIVATE_NETWORK,
      publicUrl: 'https://machine.tailnet.ts.net',
      authId: 'active-id',
      authMode: TUNNEL_MODE_PRIVATE_NETWORK,
      authHost: 'machine.tailnet.ts.net',
      activeController: controller,
    });

    const startResponse = createResponse();
    await app.routes.get('POST /api/openchamber/tunnel/start')({
      body: { provider: TUNNEL_PROVIDER_TAILSCALE, tailscaleHttpsPort: 0 },
    }, startResponse);

    expect(startResponse.statusCode).toBe(422);
    expect(startResponse.body.code).toBe('validation_error');
    expect(state.controller).toBe(controller);
    expect(state.authId).toBe('active-id');
    expect(state.authMode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
    expect(state.authHost).toBe('machine.tailnet.ts.net');

    const statusResponse = createResponse();
    await app.routes.get('GET /api/openchamber/tunnel/status')({}, statusResponse);
    expect(statusResponse.body).toMatchObject({
      active: true,
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_PRIVATE_NETWORK,
      url: 'https://machine.tailnet.ts.net',
    });

    const stopResponse = createResponse();
    await app.routes.get('POST /api/openchamber/tunnel/stop')({}, stopResponse);
    expect(state.stopCalls).toBe(1);
    expect(controller.stopped).toBe(true);
    expect(state.controller).toBe(null);
    expect(state.authId).toBe(null);
  });
});

