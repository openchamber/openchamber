import { describe, expect, it } from 'bun:test';
import { createTunnelRoutesRuntime } from './routes.js';
import { TunnelServiceError, isSupportedTunnelMode, normalizeOptionalPath, normalizeTunnelMode, normalizeTunnelProvider } from './types.js';

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

describe('tunnel doctor required fields', () => {
  it('retains truthiness checks for inherited dictionary members', async () => {
    const routes = new Map();
    const provider = {
      capabilities: {
        provider: 'cloudflare',
        modes: [{ key: 'quick', requires: ['constructor', 'toString', 'hostname', 'token', 'configPath'] }],
      },
    };
    const runtime = createTunnelRoutesRuntime({
      URL,
      TunnelServiceError,
      TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare',
      tunnelProviderRegistry: { get: () => provider },
      tunnelService: { checkAvailability: async () => ({ available: true }) },
      readSettingsFromDiskMigrated: async () => ({}),
      readManagedRemoteTunnelConfigFromDisk: async () => ({ tunnels: [] }),
      normalizeTunnelProvider,
      normalizeOptionalPath,
      normalizeManagedRemoteTunnelHostname: () => undefined,
      resolveManagedRemoteTunnelToken: async () => '',
      getRuntimeManagedRemoteTunnelHostname: () => undefined,
      getRuntimeManagedRemoteTunnelToken: () => '',
    });
    runtime.registerRoutes({
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
      put: (path, handler) => routes.set(`PUT ${path}`, handler),
    });
    let result;
    await routes.get('GET /api/openchamber/tunnel/doctor')(
      { query: { provider: 'cloudflare' }, body: {} },
      { json: (body) => { result = body; } },
    );
    const checks = result.modes[0].checks;
    expect(checks.find((check) => check.id === 'requirement_constructor').status).toBe('pass');
    expect(checks.find((check) => check.id === 'requirement_toString').status).toBe('pass');
    expect(checks.find((check) => check.id === 'requirement_hostname').status).toBe('fail');
    expect(checks.find((check) => check.id === 'requirement_token').status).toBe('fail');
    expect(checks.find((check) => check.id === 'requirement_configPath').status).toBe('fail');
  });
});

describe('tunnel start failure cleanup', () => {
  const createStartRuntime = ({ failConfigRead = false, startError = null, withPrevious = false } = {}) => {
    const events = [];
    const previousController = { provider: 'cloudflare', mode: 'quick', stop: () => {} };
    let activeController = withPrevious ? previousController : null;
    let stopCalls = 0;
    let clearCalls = 0;

    const tunnelService = {
      start: async () => {
        if (startError) {
          throw startError;
        }
        activeController = { provider: 'cloudflare', mode: 'quick', stop: () => {} };
        events.push('service-start');
        return { provider: 'cloudflare', publicUrl: 'https://new.example.com', activeMode: 'quick', providerMetadata: null };
      },
      stop: () => {
        stopCalls += 1;
        events.push('service-stop');
        activeController = null;
        return true;
      },
      resolveActiveProvider: () => (activeController ? 'cloudflare' : null),
      resolveActiveMode: () => (activeController ? 'quick' : null),
      getPublicUrl: () => (activeController ? 'https://old.example.com' : null),
    };

    const tunnelAuthController = {
      getActiveTunnelId: () => (withPrevious ? 'existing-tunnel-id' : null),
      getActiveTunnelMode: () => 'quick',
      revokeTunnelArtifacts: () => ({ revokedBootstrapCount: 0, invalidatedSessionCount: 0 }),
      setActiveTunnel: () => { events.push('auth-set'); },
      issueBootstrapToken: () => ({ token: 'bootstrap-token', expiresAt: 999 }),
      clearActiveTunnel: () => { clearCalls += 1; events.push('auth-clear'); },
      listTunnelSessions: () => [],
    };

    const runtime = createTunnelRoutesRuntime({
      crypto: { randomUUID: () => 'uuid-1' },
      URL,
      tunnelService,
      tunnelProviderRegistry: { get: () => null },
      tunnelAuthController,
      hasUiPassword: true,
      readSettingsFromDiskMigrated: async () => ({}),
      readManagedRemoteTunnelConfigFromDisk: async () => {
        if (failConfigRead) {
          throw new Error('managed config read failed');
        }
        return { tunnels: [] };
      },
      normalizeTunnelProvider,
      normalizeTunnelMode,
      normalizeOptionalPath,
      normalizeManagedRemoteTunnelHostname: () => undefined,
      normalizeTunnelBootstrapTtlMs: () => null,
      normalizeTunnelSessionTtlMs: () => 1000,
      isSupportedTunnelMode,
      upsertManagedRemoteTunnelToken: async () => {},
      resolveManagedRemoteTunnelToken: async () => '',
      TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
      TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare',
      TunnelServiceError,
      getActivePort: () => 4321,
      getRuntimeManagedRemoteTunnelHostname: () => undefined,
      setRuntimeManagedRemoteTunnelHostname: () => {},
      getRuntimeManagedRemoteTunnelToken: () => '',
      setRuntimeManagedRemoteTunnelToken: () => {},
      getActiveTunnelController: () => activeController,
      setActiveTunnelController: (value) => {
        events.push(value ? 'controller-set' : 'controller-null');
        activeController = value;
      },
    });

    const routes = new Map();
    runtime.registerRoutes({
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
      put: (path, handler) => routes.set(`PUT ${path}`, handler),
    });

    const invoke = async (route, req) => {
      let status = 200;
      let body;
      await routes.get(route)(req, {
        status(code) { status = code; return this; },
        json(payload) { body = payload; return this; },
      });
      return { status, body };
    };

    return {
      events,
      previousController,
      invoke,
      getActiveController: () => activeController,
      getStopCalls: () => stopCalls,
      getClearCalls: () => clearCalls,
    };
  };

  const silenceConsoleError = async (fn) => {
    const original = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = original;
    }
  };

  it('stops the just-started process when post-start work fails', async () => {
    const harness = createStartRuntime({ failConfigRead: true });
    const { status, body } = await silenceConsoleError(() => harness.invoke('POST /api/openchamber/tunnel/start', { body: {} }));
    expect(status).toBe(500);
    expect(body.code).toBe('startup_failed');
    expect(harness.getStopCalls()).toBe(1);
    expect(harness.getActiveController()).toBeNull();
    expect(harness.getClearCalls()).toBe(1);
    expect(harness.events.indexOf('service-stop')).toBeLessThan(harness.events.indexOf('auth-clear'));

    await harness.invoke('POST /api/openchamber/tunnel/stop', { body: {} });
    expect(harness.getStopCalls()).toBe(1);
  });

  it('stops the replacement process when post-start work fails over an existing tunnel', async () => {
    const harness = createStartRuntime({ failConfigRead: true, withPrevious: true });
    const { status } = await silenceConsoleError(() => harness.invoke('POST /api/openchamber/tunnel/start', { body: {} }));
    expect(status).toBe(500);
    expect(harness.getStopCalls()).toBe(1);
    expect(harness.getActiveController()).toBeNull();
    expect(harness.getClearCalls()).toBe(1);
  });

  it('preserves the previously active tunnel when the start fails before mutating state', async () => {
    const harness = createStartRuntime({
      startError: new TunnelServiceError('validation_error', 'invalid tunnel request'),
      withPrevious: true,
    });
    const { status, body } = await silenceConsoleError(() => harness.invoke('POST /api/openchamber/tunnel/start', { body: {} }));
    expect(status).toBe(422);
    expect(body.code).toBe('validation_error');
    expect(harness.getStopCalls()).toBe(0);
    expect(harness.getClearCalls()).toBe(0);
    expect(harness.getActiveController()).toBe(harness.previousController);
    expect(harness.events).not.toContain('controller-null');
  });
});
