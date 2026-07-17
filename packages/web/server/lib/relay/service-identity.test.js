import { describe, expect, it, vi } from 'bun:test';
import crypto from 'node:crypto';

import { createRelayService } from './service.js';

describe('relay service identity runtime', () => {
  it('uses the injected identity runtime without running the fallback identity path', async () => {
    const identity = {
      serverId: 'shared-server-id',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    };
    const identityRuntime = { getRelayIdentity: vi.fn(async () => identity) };
    const readSettingsStrict = vi.fn(async () => { throw new Error('fallback identity path should not run'); });
    const writeSettingsToDisk = vi.fn(async () => { throw new Error('identity settings should not be generated'); });
    const service = createRelayService({
      crypto,
      identityRuntime,
      readSettingsFromDiskMigrated: async () => ({
        privateRelay: { enabled: false, relayUrl: 'wss://relay.example/ws' },
      }),
      readSettingsStrict,
      writeSettingsToDisk,
      getLocalPort: () => 3000,
    });

    expect(await service.getServerId()).toBe('shared-server-id');
    expect(await service.getStatus()).toMatchObject({
      enabled: false,
      state: 'disabled',
      serverId: 'shared-server-id',
    });
    expect(identityRuntime.getRelayIdentity).toHaveBeenCalledTimes(2);
    expect(readSettingsStrict).not.toHaveBeenCalled();
    expect(writeSettingsToDisk).not.toHaveBeenCalled();
  });
});
