import { afterEach, describe, expect, it, vi } from 'bun:test';
import http from 'node:http';
import crypto from 'node:crypto';

import { createDirectE2eeRuntime } from './runtime.js';

const runtimes = [];
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
};
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
});

const fixture = async (overrides = {}) => {
  const server = http.createServer();
  let settings = {};
  let profiles = [{
    id: 'profile-a', name: 'A', hostname: 'a.example.com', token: 'secret', directE2eeEnabled: true,
  }];
  let controller = {
    mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-a', getPublicUrl: () => 'https://a.example.com',
  };
  const runtime = createDirectE2eeRuntime({
    crypto,
    httpServer: server,
    readSettingsFromDiskMigrated: async () => settings,
    writeSettingsToDisk: async (next) => { settings = next; },
    readManagedRemoteTunnelConfigFromDisk: async () => ({ tunnels: profiles }),
    getActiveTunnelController: () => controller,
    getLocalPort: () => 3000,
    internalTransportMarker: 'marker',
    authenticateBearerToken: async () => null,
    ...overrides,
  });
  runtimes.push(runtime);
  return {
    runtime,
    server,
    setProfile: (next) => { profiles = next ? [next] : []; },
    setProfiles: (next) => { profiles = next; },
    setController: (next) => { controller = next; },
  };
};

describe('direct E2EE production runtime', () => {
  it('uses an injected relay identity runtime without reading or generating local identity settings', async () => {
    const identityRuntime = {
      getRelayIdentity: vi.fn(async () => ({
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      })),
    };
    const readSettingsFromDiskMigrated = vi.fn(async () => { throw new Error('local identity read should not run'); });
    const readSettingsStrict = vi.fn(async () => { throw new Error('strict identity read should not run'); });
    const writeSettingsToDisk = vi.fn(async () => { throw new Error('local identity write should not run'); });
    const fx = await fixture({
      identityRuntime,
      readSettingsFromDiskMigrated,
      readSettingsStrict,
      writeSettingsToDisk,
    });

    await fx.runtime.initialize();
    const candidate = await fx.runtime.getPairingCandidate();

    expect(candidate?.hostEncPubJwk).toEqual({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' });
    expect(identityRuntime.getRelayIdentity).toHaveBeenCalledTimes(1);
    expect(readSettingsFromDiskMigrated).not.toHaveBeenCalled();
    expect(readSettingsStrict).not.toHaveBeenCalled();
    expect(writeSettingsToDisk).not.toHaveBeenCalled();
  });

  it('reports support only after initialization and owns one removable upgrade listener', async () => {
    const fx = await fixture();
    expect(fx.runtime.initialized).toBe(false);
    expect(fx.server.listenerCount('upgrade')).toBe(0);
    await fx.runtime.initialize();
    await fx.runtime.initialize();
    expect(fx.runtime.initialized).toBe(true);
    expect(fx.server.listenerCount('upgrade')).toBe(1);
    fx.runtime.stop();
    expect(fx.runtime.initialized).toBe(false);
    expect(fx.server.listenerCount('upgrade')).toBe(0);
  });

  it('coexists with an existing upgrade listener and removes only its own listener on stop', async () => {
    const fx = await fixture();
    let existingCalls = 0;
    const existing = (req, socket) => {
      if (req.url === '/other') {
        existingCalls += 1;
        socket.end('handled');
      }
    };
    const emitOtherUpgrade = () => {
      let output = '';
      const socket = { destroyed: false, end: (value = '') => { output += value; } };
      fx.server.emit('upgrade', { url: '/other', rawHeaders: ['Host', 'localhost'], headers: { host: 'localhost' } }, socket, Buffer.alloc(0));
      return output;
    };
    fx.server.on('upgrade', existing);
    await fx.runtime.initialize();
    expect(fx.server.listeners('upgrade')).toEqual([existing, expect.any(Function)]);
    expect(emitOtherUpgrade()).toBe('handled');
    expect(existingCalls).toBe(1);
    fx.runtime.stop();
    expect(fx.server.listeners('upgrade')).toEqual([existing]);
    expect(emitOtherUpgrade()).toBe('handled');
    expect(existingCalls).toBe(2);
  });

  it('emits a canonical candidate only for the exact active enabled managed profile', async () => {
    const fx = await fixture();
    await fx.runtime.initialize();
    const candidate = await fx.runtime.getPairingCandidate();
    expect(candidate).toMatchObject({
      type: 'direct-e2ee',
      wssUrl: 'wss://a.example.com/api/openchamber/direct-e2ee/ws',
      priority: 20,
    });
    expect(candidate.hostEncPubJwk).not.toHaveProperty('d');
    expect(fx.runtime.isAvailableFor({
      profile: { id: 'profile-a', hostname: 'a.example.com', directE2eeEnabled: true },
      publicUrl: 'https://a.example.com',
      activeMode: 'managed-remote',
    })).toBe(true);

    fx.setController({ mode: 'quick', managedRemoteTunnelPresetId: 'profile-a', getPublicUrl: () => 'https://a.example.com' });
    await fx.runtime.refresh();
    expect(await fx.runtime.getPairingCandidate()).toBeNull();
    fx.setController({ mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-b', getPublicUrl: () => 'https://a.example.com' });
    await fx.runtime.refresh();
    expect(await fx.runtime.getPairingCandidate()).toBeNull();
    fx.setController({ mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-a', getPublicUrl: () => 'https://other.example.com' });
    await fx.runtime.refresh();
    expect(await fx.runtime.getPairingCandidate()).toBeNull();
    fx.setController({ mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-a', getPublicUrl: () => 'https://a.example.com' });
    fx.setProfile({ id: 'profile-a', name: 'A', hostname: 'a.example.com', token: 'secret', directE2eeEnabled: false });
    await fx.runtime.refresh();
    expect(await fx.runtime.getPairingCandidate()).toBeNull();
  });

  it('deactivates authoritative availability until an active tunnel is refreshed', async () => {
    const authenticateBearerToken = vi.fn(async () => null);
    const fx = await fixture({ authenticateBearerToken });
    await fx.runtime.initialize();
    expect(fx.runtime.isAvailable()).toBe(true);
    fx.runtime.deactivate('tunnel-stopped');
    expect(fx.runtime.isAvailable()).toBe(false);
    expect(await fx.runtime.getPairingCandidate()).toBeNull();
    expect(authenticateBearerToken).not.toHaveBeenCalled();
    await fx.runtime.refresh();
    expect(fx.runtime.isAvailable()).toBe(true);
    expect(await fx.runtime.getPairingCandidate()).not.toBeNull();
  });

  it('closes the previous profile sessions when authority changes under the same profile id', async () => {
    const closeProfile = vi.fn();
    let serviceOptions;
    const fx = await fixture({
      createService: (options) => {
        serviceOptions = options;
        return {
          attach: vi.fn(), detach: vi.fn(), closeProfile, closeAll: vi.fn(), revokeClient: vi.fn(),
          getActiveSessionCount: vi.fn(() => 0),
        };
      },
    });
    await fx.runtime.initialize();
    expect(serviceOptions.getActiveProfile()).toEqual({
      id: 'profile-a', name: 'A', hostname: 'a.example.com', directE2eeEnabled: true,
      mode: 'managed-remote', publicUrl: 'https://a.example.com',
    });
    expect(serviceOptions.getActiveProfile()).not.toHaveProperty('token');

    fx.setProfile({
      id: 'profile-a', name: 'A', hostname: 'b.example.com', token: 'new-secret', directE2eeEnabled: true,
    });
    fx.setController({
      mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-a', getPublicUrl: () => 'https://b.example.com',
    });
    await fx.runtime.refresh({ closePreviousReason: 'profile-switched' });
    expect(closeProfile).toHaveBeenCalledWith('profile-a', 'profile-switched');
    expect(serviceOptions.getActiveProfile()).not.toHaveProperty('token');
  });

  it('uses a unique enabled hostname match only when the active controller has no profile id', async () => {
    const fx = await fixture();
    fx.setController({ mode: 'managed-remote', getPublicUrl: () => 'https://a.example.com' });
    await fx.runtime.initialize();
    expect(fx.runtime.isAvailable()).toBe(true);

    fx.setProfiles([
      { id: 'profile-a', name: 'A', hostname: 'a.example.com', directE2eeEnabled: true },
      { id: 'profile-b', name: 'B', hostname: 'a.example.com', directE2eeEnabled: true },
    ]);
    await fx.runtime.refresh();
    expect(fx.runtime.isAvailable()).toBe(false);

    fx.setProfile(null);
    await fx.runtime.refresh();
    expect(fx.runtime.isAvailable()).toBe(false);
  });

  it('never falls back by hostname when an explicit wrong profile id is present', async () => {
    const fx = await fixture();
    fx.setController({ mode: 'managed-remote', managedRemoteTunnelPresetId: 'missing', getPublicUrl: () => 'https://a.example.com' });
    await fx.runtime.initialize();
    expect(fx.runtime.isAvailable()).toBe(false);
  });

  it('generation-fences interleaved refreshes and stop during refresh', async () => {
    const first = deferred();
    const second = deferred();
    let reads = 0;
    const closeProfile = vi.fn();
    const fx = await fixture({
      readManagedRemoteTunnelConfigFromDisk: () => {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      },
      createService: () => ({
        attach: vi.fn(), detach: vi.fn(), closeProfile, closeAll: vi.fn(), revokeClient: vi.fn(),
        getActiveSessionCount: vi.fn(() => 0),
      }),
    });
    const initializing = fx.runtime.initialize();
    fx.setController({ mode: 'managed-remote', managedRemoteTunnelPresetId: 'profile-b', getPublicUrl: () => 'https://b.example.com' });
    const newer = fx.runtime.refresh();
    second.resolve({ tunnels: [{ id: 'profile-b', name: 'B', hostname: 'b.example.com', directE2eeEnabled: true }] });
    await newer;
    first.resolve({ tunnels: [{ id: 'profile-a', name: 'A', hostname: 'a.example.com', directE2eeEnabled: true }] });
    await initializing;
    expect(fx.runtime.getPairingState()?.suppressOrigin).toBe('https://b.example.com');
    expect(closeProfile).not.toHaveBeenCalled();

    const pending = deferred();
    fx.runtime.stop();
    const stoppedFx = await fixture({ readManagedRemoteTunnelConfigFromDisk: () => pending.promise });
    const refresh = stoppedFx.runtime.initialize();
    stoppedFx.runtime.stop();
    pending.resolve({ tunnels: [{ id: 'profile-a', name: 'A', hostname: 'a.example.com', directE2eeEnabled: true }] });
    await refresh;
    expect(stoppedFx.runtime.isAvailable()).toBe(false);
  });

  it('publishes safe unavailable state when the latest refresh fails', async () => {
    let fail = false;
    const fx = await fixture({
      readManagedRemoteTunnelConfigFromDisk: async () => {
        if (fail) throw new Error('config unavailable');
        return { tunnels: [{ id: 'profile-a', name: 'A', hostname: 'a.example.com', directE2eeEnabled: true }] };
      },
    });
    await fx.runtime.initialize();
    expect(fx.runtime.isAvailable()).toBe(true);
    fail = true;
    await expect(fx.runtime.refresh()).rejects.toThrow('config unavailable');
    expect(fx.runtime.isAvailable()).toBe(false);
    expect(fx.runtime.getPairingState()).toBeNull();
  });
});
