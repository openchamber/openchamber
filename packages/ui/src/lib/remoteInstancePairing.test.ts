import { describe, expect, test } from 'bun:test';

import type { PairingConnectionPayload } from './connectionPayload';
import { PairingRedemptionError } from './pairingCandidateRedemption';
import { redeemRemoteInstancePairing } from './remoteInstancePairing';

const payload: PairingConnectionPayload = {
  v: 2,
  label: 'Server',
  pairingId: 'pairing-id',
  secret: 'secret',
  candidates: [{ type: 'lan', url: 'https://server.example' }],
};

describe('remote instance pairing failures', () => {
  test('preserves every pairing failure classification as safe localized keys', async () => {
    const cases = [
      ['unreachable', 'mobile.connect.error.unreachable'],
      ['security', 'mobile.connect.error.pairingSecurity'],
      ['credential', 'mobile.connect.error.authRequired'],
      ['ambiguous', 'mobile.connect.error.pairingUncertain'],
      ['authorization', 'mobile.connect.error.authRequired'],
    ] as const;

    for (const [classification, errorKey] of cases) {
      const result = await redeemRemoteInstancePairing(payload, { redeemBody: {} }, async () => {
        throw new PairingRedemptionError(classification, 'wss://private.example crypto detail');
      });
      expect(result).toEqual({ ok: false, errorKey });
    }
  });

  test('maps unknown failures to safe uncertain copy without returning raw details', async () => {
    const result = await redeemRemoteInstancePairing(payload, { redeemBody: {} }, async () => {
      throw new Error('wss://private.example internal detail');
    });
    expect(result).toEqual({ ok: false, errorKey: 'mobile.connect.error.pairingUncertain' });
    expect(JSON.stringify(result)).not.toContain('private.example');
  });
});
