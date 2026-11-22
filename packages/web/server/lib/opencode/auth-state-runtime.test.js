import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createOpenCodeAuthStateRuntime } from './auth-state-runtime.js';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

// Fixture values only. Assertions compare SHA-256 hashes, matching how a
// real rotation is verified without printing a credential.
const SAVED_PASSWORD = 'saved-fixture-password';
const USER_PASSWORD = 'user-fixture-password';

const createHarness = ({ userProvidedPassword = null } = {}) => {
  const state = { password: null, source: null };
  const runtime = createOpenCodeAuthStateRuntime({
    crypto,
    process: { env: {} },
    getAuthPassword: () => state.password,
    setAuthPassword: (value) => {
      state.password = value;
    },
    getAuthSource: () => state.source,
    setAuthSource: (value) => {
      state.source = value;
    },
    getUserProvidedPassword: () => userProvidedPassword,
    syncToHmrState: () => {},
  });
  return { runtime, state };
};

describe('managed OpenCode password resolution', () => {
  it('a user-provided password wins over rotation and reuse', async () => {
    const { runtime, state } = createHarness({ userProvidedPassword: USER_PASSWORD });

    const result = await runtime.ensureLocalOpenCodeServerPassword({ rotateManaged: true, reusePassword: SAVED_PASSWORD });

    expect(sha256(result)).toBe(sha256(USER_PASSWORD));
    expect(state.source).toBe('user-env');
  });

  it('a user-provided password also wins on a rotation start with no reuse value', async () => {
    const { runtime, state } = createHarness({ userProvidedPassword: USER_PASSWORD });

    const result = await runtime.ensureLocalOpenCodeServerPassword({ rotateManaged: true, reusePassword: null });

    expect(sha256(result)).toBe(sha256(USER_PASSWORD));
    expect(state.source).toBe('user-env');
  });

  it('rotation with no reuse value generates a fresh password', async () => {
    const { runtime, state } = createHarness();

    const result = await runtime.ensureLocalOpenCodeServerPassword({ rotateManaged: true, reusePassword: null });

    expect(result.length).toBeGreaterThan(0);
    expect(state.password).toBe(result);
    expect(sha256(result)).not.toBe(sha256(SAVED_PASSWORD));
    expect(state.source).toBe('rotated');
  });

  it('a saved password passed for reuse wins, so adopt and handoff starts keep it', async () => {
    const { runtime, state } = createHarness();

    const result = await runtime.ensureLocalOpenCodeServerPassword({ rotateManaged: true, reusePassword: SAVED_PASSWORD });

    expect(sha256(result)).toBe(sha256(SAVED_PASSWORD));
    expect(state.source).toBe('generated');
  });
});
