import { describe, expect, it, vi } from 'bun:test';
import express from 'express';
import request from 'supertest';

import { createTunnelRoutesRuntime } from './routes.js';
import { TunnelServiceError } from './types.js';

const profile = { id: 'profile-a', name: 'A', hostname: 'a.example.com', token: 'connector-secret', directE2eeEnabled: true };

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    crypto: { randomUUID: () => 'tunnel-id' },
    URL,
    tunnelService: {
      resolveActiveMode: () => 'managed-remote', resolveActiveProvider: () => 'cloudflare',
      getPublicUrl: () => 'https://a.example.com', getProviderMetadata: () => ({ managedRemoteTunnelPresetId: 'profile-a' }),
    },
    tunnelProviderRegistry: { get: () => null, listCapabilities: () => [] },
    tunnelAuthController: {
      listTunnelSessions: () => [], getActiveTunnelMode: () => 'managed-remote', getActiveTunnelId: () => 'tunnel-id',
      getActiveTunnelHost: () => 'a.example.com', getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
    },
    readSettingsFromDiskMigrated: async () => ({ tunnelMode: 'managed-remote', tunnelProvider: 'cloudflare' }),
    readManagedRemoteTunnelConfigFromDisk: async () => ({ version: 1, tunnels: [profile] }),
    normalizeTunnelProvider: (value) => value || 'cloudflare', normalizeTunnelMode: (value) => value || 'quick',
    normalizeOptionalPath: (value) => value, normalizeManagedRemoteTunnelHostname: (value) => typeof value === 'string' ? value.toLowerCase() : '',
    normalizeTunnelBootstrapTtlMs: (value) => value ?? 1, normalizeTunnelSessionTtlMs: (value) => value ?? 1,
    isSupportedTunnelMode: () => true, upsertManagedRemoteTunnelToken: vi.fn(async () => {}),
    setManagedRemoteTunnelDirectE2eeEnabled: vi.fn(async () => profile), resolveManagedRemoteTunnelToken: async () => '',
    TUNNEL_MODE_QUICK: 'quick', TUNNEL_MODE_MANAGED_LOCAL: 'managed-local', TUNNEL_MODE_MANAGED_REMOTE: 'managed-remote',
    TUNNEL_PROVIDER_CLOUDFLARE: 'cloudflare', TunnelServiceError, getActivePort: () => 3000,
    getRuntimeManagedRemoteTunnelHostname: () => '', setRuntimeManagedRemoteTunnelHostname: () => {},
    getRuntimeManagedRemoteTunnelToken: () => '', setRuntimeManagedRemoteTunnelToken: () => {},
    getActiveTunnelController: () => null, setActiveTunnelController: () => {},
    getDirectE2eeActiveSessionCount: () => 3,
    directE2eeSupported: true,
    isDirectE2eeAvailable: ({ profile: activeProfile }) => activeProfile?.id === 'profile-a' && activeProfile.directE2eeEnabled === true,
    ...overrides,
  };
  createTunnelRoutesRuntime(dependencies).registerRoutes(app);
  return { app, dependencies };
};

describe('tunnel routes direct E2EE configuration', () => {
  it('patches only the selected flag and never returns the token', async () => {
    const { app, dependencies } = createApp();
    const response = await request(app).patch('/api/openchamber/tunnel/managed-remote-profile/profile-a').send({ directE2eeEnabled: false }).expect(200);
    expect(dependencies.setManagedRemoteTunnelDirectE2eeEnabled).toHaveBeenCalledWith({ id: 'profile-a', directE2eeEnabled: false });
    expect(response.body.profile).toEqual({ id: 'profile-a', name: 'A', hostname: 'a.example.com', directE2eeEnabled: false });
    expect(JSON.stringify(response.body)).not.toContain('connector-secret');
  });

  it('rejects invalid values and unknown profiles', async () => {
    const { app } = createApp();
    await request(app).patch('/api/openchamber/tunnel/managed-remote-profile/profile-a').send({ directE2eeEnabled: 1 }).expect(400);
    await request(app).patch('/api/openchamber/tunnel/managed-remote-profile/missing').send({ directE2eeEnabled: true }).expect(404);
  });

  it('returns explicit server failures instead of empty status or profile-not-found on config read errors', async () => {
    const readFailure = new Error('managed config unreadable');
    const setManagedRemoteTunnelDirectE2eeEnabled = vi.fn(async () => profile);
    const { app } = createApp({
      readManagedRemoteTunnelConfigFromDisk: async () => { throw readFailure; },
      setManagedRemoteTunnelDirectE2eeEnabled,
    });

    await request(app).get('/api/openchamber/tunnel/status').expect(500, { error: 'Failed to get tunnel status' });
    await request(app)
      .patch('/api/openchamber/tunnel/managed-remote-profile/profile-a')
      .send({ directE2eeEnabled: false })
      .expect(500, { ok: false, error: 'Failed to update managed remote profile' });
    expect(setManagedRemoteTunnelDirectE2eeEnabled).not.toHaveBeenCalled();
  });

  it('fails token writes explicitly when the authoritative mutation rejects', async () => {
    const onTunnelChanged = vi.fn(async () => {});
    const upsertManagedRemoteTunnelToken = vi.fn(async () => { throw new Error('managed config corrupt'); });
    const { app } = createApp({ upsertManagedRemoteTunnelToken, onTunnelChanged });

    await request(app).put('/api/openchamber/tunnel/managed-remote-token').send({
      presetId: 'profile-a', presetName: 'A', managedRemoteTunnelHostname: 'a.example.com', managedRemoteTunnelToken: 'new-secret',
    }).expect(500, { ok: false, error: 'Failed to save managed remote tunnel token' });
    expect(onTunnelChanged).not.toHaveBeenCalled();
  });

  it('refreshes direct runtime after a managed profile token upsert', async () => {
    const onTunnelChanged = vi.fn(async () => {});
    const { app } = createApp({ onTunnelChanged });
    await request(app).put('/api/openchamber/tunnel/managed-remote-token').send({
      presetId: 'profile-a', presetName: 'A', managedRemoteTunnelHostname: 'a.example.com', managedRemoteTunnelToken: 'new-secret',
    }).expect(200);
    expect(onTunnelChanged).toHaveBeenCalledWith({ reason: 'profile-upserted', profileId: 'profile-a' });
  });

  it('reports production support and availability for the exact active profile', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/openchamber/tunnel/status').expect(200);
    expect(response.body).toMatchObject({
      activeManagedRemoteProfileId: 'profile-a', directE2eeActiveSessions: 3,
      directE2eeConfigured: true, directE2eeSupported: true, directE2eeAvailable: true,
    });
    expect(response.body.managedRemoteTunnelPresets[0].directE2eeEnabled).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('connector-secret');
  });

  it('replaces route artifacts and tunnel identity when the managed profile changes at the same URL', async () => {
    const revokeTunnelArtifacts = vi.fn(() => ({ revokedBootstrapCount: 2, invalidatedSessionCount: 3 }));
    const setActiveTunnel = vi.fn();
    const onTunnelChanged = vi.fn(async () => {});
    const { app } = createApp({
      crypto: { randomUUID: () => 'fresh-tunnel-id' },
      tunnelService: {
        resolveActiveMode: () => 'managed-remote',
        resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://shared.example.com',
        getProviderMetadata: () => ({ managedRemoteTunnelPresetId: 'profile-a' }),
        start: async () => ({
          publicUrl: 'https://shared.example.com',
          activeMode: 'managed-remote',
          provider: 'cloudflare',
          providerMetadata: { managedRemoteTunnelPresetId: 'profile-b' },
        }),
      },
      tunnelProviderRegistry: { get: () => ({}), listCapabilities: () => [] },
      tunnelAuthController: {
        listTunnelSessions: () => [],
        getActiveTunnelMode: () => 'managed-remote',
        getActiveTunnelId: () => 'old-tunnel-id',
        revokeTunnelArtifacts,
        setActiveTunnel,
        issueBootstrapToken: () => ({ token: 'bootstrap', expiresAt: 123 }),
      },
      resolveManagedRemoteTunnelToken: async () => 'connector-secret',
      onTunnelChanged,
      readManagedRemoteTunnelConfigFromDisk: async () => ({ version: 1, tunnels: [
        profile,
        { ...profile, id: 'profile-b', name: 'B' },
      ] }),
    });

    const response = await request(app).post('/api/openchamber/tunnel/start').send({
      provider: 'cloudflare',
      mode: 'managed-remote',
      managedRemoteTunnelPresetId: 'profile-b',
      managedRemoteTunnelPresetName: 'B',
      hostname: 'shared.example.com',
    }).expect(200);

    expect(response.body).toMatchObject({
      replacedTunnel: true,
      revokedBootstrapCount: 2,
      invalidatedSessionCount: 3,
    });
    expect(revokeTunnelArtifacts).toHaveBeenCalledWith('old-tunnel-id');
    expect(setActiveTunnel).toHaveBeenCalledWith({
      tunnelId: 'fresh-tunnel-id',
      publicUrl: 'https://shared.example.com',
      mode: 'managed-remote',
    });
    expect(onTunnelChanged).toHaveBeenCalledWith({ reason: 'profile-switched' });
  });

  it('invokes direct-session lifecycle callbacks on disable and stop', async () => {
    const onManagedRemoteDirectE2eeDisabled = vi.fn();
    const onTunnelChanged = vi.fn(async () => {});
    const onTunnelStopped = vi.fn();
    const { app } = createApp({
      onManagedRemoteDirectE2eeDisabled,
      onTunnelChanged,
      onTunnelStopped,
      tunnelService: {
        resolveActiveMode: () => 'managed-remote',
        resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://a.example.com',
        getProviderMetadata: () => ({ managedRemoteTunnelPresetId: 'profile-a' }),
        stop: vi.fn(),
      },
      getActiveTunnelController: () => ({ stop: vi.fn() }),
      tunnelAuthController: {
        listTunnelSessions: () => [], getActiveTunnelMode: () => 'managed-remote', getActiveTunnelId: () => null,
        getActiveTunnelHost: () => 'a.example.com', getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
        clearActiveTunnel: vi.fn(),
      },
    });

    await request(app)
      .patch('/api/openchamber/tunnel/managed-remote-profile/profile-a')
      .send({ directE2eeEnabled: false })
      .expect(200);
    expect(onManagedRemoteDirectE2eeDisabled).toHaveBeenCalledWith('profile-a');
    expect(onTunnelChanged).toHaveBeenCalledWith({ reason: 'profile-direct-e2ee-updated', profileId: 'profile-a' });

    await request(app).post('/api/openchamber/tunnel/stop').expect(200);
    expect(onTunnelStopped).toHaveBeenCalledWith('tunnel-stopped');
  });

  it('deactivates direct runtime when provider startup fails', async () => {
    let directAvailable = true;
    let closedDirectSessions = 0;
    const onTunnelStopped = vi.fn(async () => {
      directAvailable = false;
      closedDirectSessions += 2;
    });
    const clearActiveTunnel = vi.fn();
    const setActiveTunnelController = vi.fn();
    const { app } = createApp({
      onTunnelStopped,
      isDirectE2eeAvailable: () => directAvailable,
      setActiveTunnelController,
      tunnelProviderRegistry: { get: () => ({}), listCapabilities: () => [] },
      tunnelService: {
        resolveActiveMode: () => 'managed-remote', resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://a.example.com', getProviderMetadata: () => ({ managedRemoteTunnelPresetId: 'profile-a' }),
        start: async () => { throw new TunnelServiceError('startup_failed', 'provider failed'); },
      },
      tunnelAuthController: {
        listTunnelSessions: () => [], getActiveTunnelMode: () => 'managed-remote', getActiveTunnelId: () => 'old',
        getActiveTunnelHost: () => 'a.example.com', getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
        clearActiveTunnel,
      },
    });
    await request(app).post('/api/openchamber/tunnel/start').send({
      provider: 'cloudflare', mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-a', hostname: 'a.example.com',
    }).expect(500);
    expect(setActiveTunnelController).toHaveBeenCalledWith(null);
    expect(clearActiveTunnel).toHaveBeenCalled();
    expect(onTunnelStopped).toHaveBeenCalledWith('tunnel-start-failed');
    expect(closedDirectSessions).toBe(2);
    expect((await request(app).get('/api/openchamber/tunnel/status').expect(200)).body.directE2eeAvailable).toBe(false);
  });

  it('preserves structured start failures when the stopped callback rejects', async () => {
    const callbackError = new Error('callback-secret=https://private.example/?token=secret');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createApp({
      onTunnelStopped: async () => { throw callbackError; },
      tunnelProviderRegistry: { get: () => ({}), listCapabilities: () => [] },
      tunnelService: {
        resolveActiveMode: () => 'managed-remote', resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://a.example.com', getProviderMetadata: () => ({ managedRemoteTunnelPresetId: 'profile-a' }),
        start: async () => { throw new TunnelServiceError('startup_failed', 'provider failed'); },
      },
      tunnelAuthController: {
        listTunnelSessions: () => [], getActiveTunnelMode: () => 'managed-remote', getActiveTunnelId: () => 'old',
        getActiveTunnelHost: () => 'a.example.com', getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
        clearActiveTunnel: vi.fn(),
      },
    });

    try {
      await request(app).post('/api/openchamber/tunnel/start').send({
        provider: 'cloudflare', mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-a', hostname: 'a.example.com',
      }).expect(500, { ok: false, error: 'provider failed', code: 'startup_failed' });
      expect(consoleError).toHaveBeenCalledWith('Tunnel lifecycle callback failed (tunnel-stopped:start-failed)');
      expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain('callback-secret');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns a structured lifecycle failure with revocation counts when stop cleanup rejects', async () => {
    const callbackError = Object.assign(new Error('stop-secret=https://private.example/?token=secret'), { code: 'ETIMEDOUT' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createApp({
      onTunnelStopped: async () => { throw callbackError; },
      tunnelService: {
        resolveActiveMode: () => 'managed-remote', resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://a.example.com', getProviderMetadata: () => ({ managedRemoteTunnelPresetId: 'profile-a' }),
        stop: vi.fn(),
      },
      getActiveTunnelController: () => ({ stop: vi.fn() }),
      tunnelAuthController: {
        listTunnelSessions: () => [], getActiveTunnelMode: () => 'managed-remote', getActiveTunnelId: () => null,
        getActiveTunnelHost: () => 'a.example.com', getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
        clearActiveTunnel: vi.fn(),
      },
    });

    try {
      await request(app).post('/api/openchamber/tunnel/stop').expect(500, {
        ok: false,
        error: 'Tunnel lifecycle cleanup failed',
        code: 'lifecycle_callback_failed',
        revokedBootstrapCount: 0,
        invalidatedSessionCount: 0,
      });
      expect(consoleError).toHaveBeenCalledWith(
        'Tunnel lifecycle callback failed (tunnel-stopped:stop)',
        { name: 'Error', code: 'ETIMEDOUT' },
      );
      expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain('stop-secret');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves token upsert responses when the changed callback rejects', async () => {
    const callbackError = Object.assign(new Error('token-secret=https://private.example/?token=secret'), { code: 'ETIMEDOUT' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createApp({ onTunnelChanged: async () => { throw callbackError; } });

    try {
      await request(app).put('/api/openchamber/tunnel/managed-remote-token').send({
        presetId: 'profile-a', presetName: 'A', managedRemoteTunnelHostname: 'a.example.com', managedRemoteTunnelToken: 'new-secret',
      }).expect(200, { ok: true, managedRemoteTunnelTokenPresetIds: ['profile-a'] });
      expect(consoleError).toHaveBeenCalledWith(
        'Tunnel lifecycle callback failed (tunnel-changed:profile-upserted)',
        { name: 'Error', code: 'ETIMEDOUT' },
      );
      expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain('token-secret');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps a disabled profile persisted but returns a lifecycle failure when revocation rejects', async () => {
    const disabledError = Object.assign(new Error('disable-secret=https://private.example/?token=secret'), { code: 'EIO' });
    const onTunnelChanged = vi.fn(async () => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, dependencies } = createApp({
      onManagedRemoteDirectE2eeDisabled: async () => { throw disabledError; },
      onTunnelChanged,
    });

    try {
      await request(app)
        .patch('/api/openchamber/tunnel/managed-remote-profile/profile-a')
        .send({ directE2eeEnabled: false })
        .expect(500, {
          ok: false,
          error: 'Tunnel lifecycle cleanup failed',
          code: 'lifecycle_callback_failed',
        });
      expect(dependencies.setManagedRemoteTunnelDirectE2eeEnabled).toHaveBeenCalledWith({
        id: 'profile-a', directE2eeEnabled: false,
      });
      expect(onTunnelChanged).toHaveBeenCalledWith({ reason: 'profile-direct-e2ee-updated', profileId: 'profile-a' });
      expect(consoleError).toHaveBeenCalledWith(
        'Tunnel lifecycle callback failed (direct-e2ee-disabled)',
        { name: 'Error', code: 'EIO' },
      );
      expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain('disable-secret');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves profile responses when the changed notification rejects', async () => {
    const changedError = new TypeError('changed-secret=https://private.example/?token=secret');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createApp({ onTunnelChanged: async () => { throw changedError; } });

    try {
      await request(app)
        .patch('/api/openchamber/tunnel/managed-remote-profile/profile-a')
        .send({ directE2eeEnabled: true })
        .expect(200);
      expect(consoleError).toHaveBeenCalledWith(
        'Tunnel lifecycle callback failed (tunnel-changed:profile-direct-e2ee-updated)',
        { name: 'TypeError' },
      );
      expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain('changed-secret');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves successful start responses when the changed callback rejects', async () => {
    const callbackError = new Error('start-secret=https://private.example/?token=secret');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createApp({
      onTunnelChanged: async () => { throw callbackError; },
      tunnelProviderRegistry: { get: () => ({}), listCapabilities: () => [] },
      tunnelService: {
        resolveActiveMode: () => 'managed-remote', resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://a.example.com', getProviderMetadata: () => ({ managedRemoteTunnelPresetId: 'profile-a' }),
        start: async () => ({
          publicUrl: 'https://a.example.com', activeMode: 'managed-remote', provider: 'cloudflare',
          providerMetadata: { managedRemoteTunnelPresetId: 'profile-a' },
        }),
      },
      tunnelAuthController: {
        listTunnelSessions: () => [], getActiveTunnelMode: () => 'managed-remote', getActiveTunnelId: () => null,
        getActiveTunnelHost: () => 'a.example.com', getBootstrapStatus: () => ({ hasBootstrapToken: false, bootstrapExpiresAt: null }),
        setActiveTunnel: vi.fn(), issueBootstrapToken: () => ({ token: 'bootstrap', expiresAt: 123 }),
      },
    });

    try {
      await request(app).post('/api/openchamber/tunnel/start').send({
        provider: 'cloudflare', mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-a', hostname: 'a.example.com',
      }).expect(200);
      expect(consoleError).toHaveBeenCalledWith(
        'Tunnel lifecycle callback failed (tunnel-changed:profile-switched)',
        { name: 'Error' },
      );
      expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain('start-secret');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('awaits best-effort notification settlement before sending the response', async () => {
    let rejectCallback;
    let responseSettled = false;
    const callbackError = new Error('settlement-secret');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onTunnelChanged = vi.fn(() => new Promise((_resolve, reject) => {
      rejectCallback = reject;
    }));
    const { app } = createApp({ onTunnelChanged });

    try {
      const responsePromise = request(app)
        .put('/api/openchamber/tunnel/managed-remote-token')
        .send({
          presetId: 'profile-a', presetName: 'A', managedRemoteTunnelHostname: 'a.example.com', managedRemoteTunnelToken: 'new-secret',
        })
        .then((response) => {
          responseSettled = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onTunnelChanged).toHaveBeenCalled();
      expect(responseSettled).toBe(false);
      rejectCallback(callbackError);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain('settlement-secret');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('uses only a unique enabled hostname fallback for legacy active metadata', async () => {
    const { app } = createApp({
      tunnelService: {
        resolveActiveMode: () => 'managed-remote', resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://a.example.com', getProviderMetadata: () => ({}),
      },
    });
    expect((await request(app).get('/api/openchamber/tunnel/status').expect(200)).body.activeManagedRemoteProfileId).toBe('profile-a');

    const ambiguous = createApp({
      tunnelService: {
        resolveActiveMode: () => 'managed-remote', resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://a.example.com', getProviderMetadata: () => ({}),
      },
      readManagedRemoteTunnelConfigFromDisk: async () => ({ tunnels: [profile, { ...profile, id: 'profile-b' }] }),
    });
    expect((await request(ambiguous.app).get('/api/openchamber/tunnel/status').expect(200)).body.activeManagedRemoteProfileId).toBeNull();

    const wrongId = createApp({
      tunnelService: {
        resolveActiveMode: () => 'managed-remote', resolveActiveProvider: () => 'cloudflare',
        getPublicUrl: () => 'https://a.example.com', getProviderMetadata: () => ({ managedRemoteTunnelPresetId: 'missing' }),
      },
    });
    expect((await request(wrongId.app).get('/api/openchamber/tunnel/status').expect(200)).body.activeManagedRemoteProfileId).toBeNull();
  });
});
