import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

import { createRelayService } from './service.js';

const makeService = (options = {}) => {
  // In-memory settings store with a pre-seeded relay identity so the service
  // never regenerates a signing key during the test.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let settings = {
    relaySigningKey: {
      privateJwk: privateKey.export({ format: 'jwk' }),
      publicJwk: publicKey.export({ format: 'jwk' }),
    },
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
    readSettingsStrict: async () => settings,
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
