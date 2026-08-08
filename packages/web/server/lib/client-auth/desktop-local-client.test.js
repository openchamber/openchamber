import { describe, expect, it, vi } from 'vitest';
import { createDesktopLocalClientMint } from './desktop-local-client.js';

describe('createDesktopLocalClientMint', () => {
  it('is unavailable outside the desktop server runtime', () => {
    expect(createDesktopLocalClientMint({ runtimeName: 'web', createClient: vi.fn() })).toBeUndefined();
  });

  it('uses a fixed privileged identity and only bounded device metadata', async () => {
    const createClient = vi.fn(async (input) => ({ client: input, token: 'secret-token' }));
    const mint = createDesktopLocalClientMint({ runtimeName: 'desktop', createClient });

    await mint({
      label: 'Attacker',
      clientKind: 'mobile',
      dedupeKey: 'attacker',
      capabilities: ['host.apply'],
      authMethod: 'password',
      pairingId: 'pairing',
      usesRelay: true,
      deviceName: `  Desktop\u0000${'x'.repeat(100)}  `,
      devicePlatform: 'macos',
      deviceModel: 123,
      appVersion: '1.2.3',
    });

    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      label: 'OpenChamber Desktop',
      clientKind: 'desktop-local',
      dedupeKey: 'desktop-local',
      authMethod: 'native-electron',
      deviceName: `Desktop${'x'.repeat(73)}`,
      devicePlatform: 'macos',
      deviceModel: undefined,
      appVersion: '1.2.3',
    });
  });
});
