import { describe, expect, it } from 'vitest';

import {
  createManagedOpenCodeHealthChallenge,
  createManagedOpenCodeHealthProof,
  verifyManagedOpenCodeHealthProof,
} from './health-proof.js';

const createInput = (overrides = {}) => ({
  password: 'managed-health-password',
  challenge: createManagedOpenCodeHealthChallenge(),
  incarnation: 'health-incarnation',
  ownerInstanceId: 'health-owner',
  runtimeIdentity: 'health-runtime',
  launchFingerprint: 'health-launch-fingerprint',
  port: 4096,
  ...overrides,
});

describe('managed OpenCode health proof', () => {
  it('binds a proof to the challenge and launch tuple', () => {
    const input = createInput();
    const proof = createManagedOpenCodeHealthProof(input);

    expect(verifyManagedOpenCodeHealthProof(input, proof)).toBe(true);
    expect(verifyManagedOpenCodeHealthProof({ ...input, port: 4097 }, proof)).toBe(false);
    expect(verifyManagedOpenCodeHealthProof({ ...input, ownerInstanceId: 'other-owner' }, proof)).toBe(false);
    expect(verifyManagedOpenCodeHealthProof({ ...input, runtimeIdentity: 'other-runtime' }, proof)).toBe(false);
    expect(verifyManagedOpenCodeHealthProof({ ...input, launchFingerprint: 'other-launch' }, proof)).toBe(false);
    expect(verifyManagedOpenCodeHealthProof({ ...input, password: 'other-password' }, proof)).toBe(false);
  });

  it('rejects malformed or replayed proof input', () => {
    const input = createInput();
    const proof = createManagedOpenCodeHealthProof(input);

    expect(verifyManagedOpenCodeHealthProof(input, `${proof}x`)).toBe(false);
    expect(verifyManagedOpenCodeHealthProof({ ...input, challenge: createManagedOpenCodeHealthChallenge() }, proof))
      .toBe(false);
    expect(() => createManagedOpenCodeHealthProof({ ...input, port: 0 })).toThrow(/Invalid managed OpenCode health proof input/);
  });
});
