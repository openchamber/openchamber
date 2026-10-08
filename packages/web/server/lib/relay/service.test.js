import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

import { createRelayService } from './service.js';

const makeService = (options = {}) => {
  // In-memory key store with a pre-seeded signing key so the service never
  // regenerates the serverId during the test.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keySlots = {
    signing: {
      privateJwk: privateKey.export({ format: 'jwk' }),
      publicJwk: publicKey.export({ format: 'jwk' }),
    },
  };
  const relayKeyStore = {
    getOrCreate: async (slot, generate) => (keySlots[slot] ??= await generate()),
  };
  let settings = {
    privateRelay: { enabled: true, relayUrl: 'wss://relay.example.test/ws' },
    ...options.settings,
  };
  const hostLock = {
    tryClaim: vi.fn(() => true),
    forceClaim: vi.fn(() => true),
    holdsClaim: vi.fn(() => true),
    liveClaimantPid: vi.fn(() => null),
    release: vi.fn(),
  };
  const service = createRelayService({
    crypto,
    readSettingsFromDiskMigrated: async () => settings,
    writeSettingsToDisk: async (next) => { settings = next; },
    relayKeyStore,
    getLocalPort: () => 0,
    hasRelayDemand: options.hasRelayDemand ?? (async () => true),
    hostLock,
    allowPassiveHost: options.allowPassiveHost,
    logger: { warn: () => {} },
  });
  return { service, hostLock, getSettings: () => settings };
};

describe('relay service passive hosting', () => {
  it('never claims or starts the host passively when passive hosting is disabled', async () => {
    const { service, hostLock } = makeService({ allowPassiveHost: false });
    try {
      await service.startIfEnabled();
      let status = await service.getStatus();
      expect(status.state).toBe('standby');
      expect(hostLock.tryClaim).not.toHaveBeenCalled();
      expect(hostLock.forceClaim).not.toHaveBeenCalled();

      await service.reconcile();
      status = await service.getStatus();
      expect(status.state).toBe('standby');
      expect(status.lastError).toContain('passive relay hosting is disabled');
      expect(hostLock.tryClaim).not.toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it('in enterprise mode runs only on a relay pinned by OPENCHAMBER_RELAY_URL', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    delete process.env.OPENCHAMBER_RELAY_URL;
    const blocked = makeService();
    try {
      await blocked.service.startIfEnabled();
      await blocked.service.reconcile();
      const status = await blocked.service.getStatus();
      expect(status).toMatchObject({ state: 'disabled', blockedByEnterprise: true });
      expect(blocked.hostLock.tryClaim).not.toHaveBeenCalled();
      expect(await blocked.service.getPairingCandidate()).toBeNull();
      await expect(blocked.service.ensureEnabledForPairing()).rejects.toMatchObject({ statusCode: 403 });
      expect(blocked.hostLock.forceClaim).not.toHaveBeenCalled();

      process.env.OPENCHAMBER_RELAY_URL = 'wss://relay.company.test/ws';
      const own = makeService();
      try {
        const candidate = await own.service.ensureEnabledForPairing();
        expect(candidate).toMatchObject({ type: 'relay', relayUrl: 'wss://relay.company.test/ws' });
        expect((await own.service.getStatus()).blockedByEnterprise).toBe(false);
      } finally {
        own.service.stop();
      }
    } finally {
      blocked.service.stop();
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
      delete process.env.OPENCHAMBER_RELAY_URL;
    }
  });

  it('force-claims for an explicit pairing even when passive hosting is disabled', async () => {
    const { service, hostLock } = makeService({ allowPassiveHost: false });
    try {
      const candidate = await service.ensureEnabledForPairing();
      expect(candidate?.type).toBe('relay');
      expect(hostLock.forceClaim).toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });
});
