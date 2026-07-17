import { describe, expect, it, vi } from 'bun:test';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

import { createRelayService } from './service.js';

const createApp = ({ initialAuthContext = { type: 'session' } } = {}) => {
  const app = express();
  let authContext = initialAuthContext;
  let settings = {
    privateRelay: { enabled: true, relayUrl: 'wss://private-relay.example/ws' },
  };
  const readSettingsFromDiskMigrated = vi.fn(async () => settings);
  const writeSettingsToDisk = vi.fn(async (next) => {
    settings = next;
  });
  const hostClient = {
    stop: vi.fn(),
    getStatus: vi.fn(() => ({ state: 'connected', lastError: null, connectedClients: 0 })),
  };
  const startRelayHostRuntime = vi.fn(() => hostClient);
  const relayService = createRelayService({
    crypto,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    getLocalPort: () => 3000,
    getUiAuthController: () => ({
      resolveAuthContext: async () => authContext,
    }),
    startRelayHostRuntime,
  });
  relayService.registerRoutes(app);
  return {
    app,
    hostClient,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    startRelayHostRuntime,
    setAuthContext: (next) => {
      authContext = next;
    },
  };
};

describe('relay management route authorization', () => {
  it('rejects ordinary paired-client lifecycle mutations before side effects', async () => {
    const fixture = createApp({
      initialAuthContext: { type: 'client', client: { id: 'phone', clientKind: null } },
    });
    const denial = { error: 'Tunnel administration requires host access.' };

    await request(fixture.app).post('/api/openchamber/relay/enable')
      .send({ relayUrl: 'wss://attacker.example/ws' }).expect(403, denial);
    await request(fixture.app).post('/api/openchamber/relay/disable').expect(403, denial);

    expect(fixture.readSettingsFromDiskMigrated).not.toHaveBeenCalled();
    expect(fixture.writeSettingsToDisk).not.toHaveBeenCalled();
    expect(fixture.startRelayHostRuntime).not.toHaveBeenCalled();
    expect(fixture.hostClient.stop).not.toHaveBeenCalled();
  });

  it('allows UI sessions and desktop-local clients to manage relay lifecycle', async () => {
    const fixture = createApp();

    await request(fixture.app).post('/api/openchamber/relay/enable')
      .send({ relayUrl: 'ws://127.0.0.1:1/ws' }).expect(200);
    expect(fixture.startRelayHostRuntime).toHaveBeenCalledTimes(1);

    fixture.setAuthContext({ type: 'client', client: { id: 'desktop', clientKind: 'desktop-local' } });
    await request(fixture.app).post('/api/openchamber/relay/disable').expect(200);
    expect(fixture.hostClient.stop).toHaveBeenCalledTimes(1);
  });

  it('returns an allowlisted read-only status to paired and unauthenticated contexts', async () => {
    const fixture = createApp({
      initialAuthContext: { type: 'client', client: { id: 'phone', clientKind: null } },
    });
    const expected = {
      enabled: true,
      state: 'disabled',
      connectedClients: 0,
      canAdminister: false,
    };

    await request(fixture.app).get('/api/openchamber/relay/status').expect(200, expected);
    fixture.setAuthContext(null);
    await request(fixture.app).get('/api/openchamber/relay/status').expect(200, expected);

    expect(fixture.writeSettingsToDisk).not.toHaveBeenCalled();
    expect(fixture.startRelayHostRuntime).not.toHaveBeenCalled();
  });

  it('marks full status as administrable for authenticated browser sessions', async () => {
    const fixture = createApp();

    const response = await request(fixture.app).get('/api/openchamber/relay/status').expect(200);

    expect(response.body).toMatchObject({
      enabled: true,
      relayUrl: 'wss://private-relay.example/ws',
      relayUrlLocked: false,
      canAdminister: true,
    });
    expect(response.body.serverId).toBeTruthy();
  });
});
