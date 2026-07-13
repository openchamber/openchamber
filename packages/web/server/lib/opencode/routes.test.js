import { describe, expect, it, vi } from 'bun:test';
import express from 'express';
import request from 'supertest';

import { registerOpenCodeRoutes } from './routes.js';

const TUNNEL_OWNED_SETTINGS = [
  ['tunnelBootstrapTtlMs', null],
  ['tunnelSessionTtlMs', 60_000],
  ['tunnelProvider', 'cloudflare'],
  ['tunnelMode', 'managed-remote'],
  ['managedLocalTunnelConfigPath', '/tmp/cloudflared.yml'],
  ['managedRemoteTunnelHostname', 'host.example.com'],
  ['managedRemoteTunnelToken', 'secret'],
  ['managedRemoteTunnelPresets', []],
  ['managedRemoteTunnelPresetTokens', {}],
  ['managedRemoteTunnelSelectedPresetId', 'profile-a'],
];

const createApp = (initialAuthContext) => {
  const app = express();
  app.use(express.json());
  let authContext = initialAuthContext;
  const persistSettings = vi.fn(async (changes) => ({ ...changes, persisted: true }));
  const resolveAuthContext = vi.fn(async () => authContext);
  registerOpenCodeRoutes(app, {
    persistSettings,
    getUiAuthController: () => ({ resolveAuthContext }),
  });
  return {
    app,
    persistSettings,
    resolveAuthContext,
    setAuthContext: (next) => {
      authContext = next;
    },
  };
};

describe('settings route tunnel administration', () => {
  it('rejects every tunnel-owned setting from ordinary paired clients before persistence', async () => {
    const fixture = createApp({ type: 'client', client: { id: 'phone', clientKind: null } });
    const denial = { error: 'Tunnel administration requires host access.' };

    for (const [key, value] of TUNNEL_OWNED_SETTINGS) {
      await request(fixture.app).put('/api/config/settings').send({ [key]: value }).expect(403, denial);
    }

    expect(fixture.persistSettings).not.toHaveBeenCalled();
    expect(fixture.resolveAuthContext).toHaveBeenCalledTimes(TUNNEL_OWNED_SETTINGS.length);
    expect(fixture.resolveAuthContext).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      { allowClientAuth: true, allowUrlToken: false },
    );
  });

  it('allows unrelated settings updates from ordinary paired clients without an administration check', async () => {
    const fixture = createApp({ type: 'client', client: { id: 'phone', clientKind: null } });

    await request(fixture.app).put('/api/config/settings').send({ themeId: 'flexoki-dark' }).expect(200, {
      themeId: 'flexoki-dark',
      persisted: true,
    });

    expect(fixture.persistSettings).toHaveBeenCalledWith({ themeId: 'flexoki-dark' });
    expect(fixture.resolveAuthContext).not.toHaveBeenCalled();
  });

  it('allows authenticated browser sessions and desktop-local clients to update tunnel settings', async () => {
    const fixture = createApp({ type: 'session' });

    await request(fixture.app).put('/api/config/settings').send({ tunnelMode: 'quick' }).expect(200);
    fixture.setAuthContext({ type: 'client', client: { id: 'desktop', clientKind: 'desktop-local' } });
    await request(fixture.app).put('/api/config/settings').send({ tunnelProvider: 'cloudflare' }).expect(200);

    expect(fixture.persistSettings).toHaveBeenNthCalledWith(1, { tunnelMode: 'quick' });
    expect(fixture.persistSettings).toHaveBeenNthCalledWith(2, { tunnelProvider: 'cloudflare' });
  });
});
