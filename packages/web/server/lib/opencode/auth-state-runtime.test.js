import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeAuthStateRuntime } from './auth-state-runtime.js';

const createFixture = () => {
  const processLike = { env: {} };
  let password = 'old-password';
  let source = 'generated';
  const syncToHmrState = vi.fn();
  const runtime = createOpenCodeAuthStateRuntime({
    crypto,
    process: processLike,
    getAuthPassword: () => password,
    setAuthPassword: (value) => { password = value; },
    getAuthSource: () => source,
    setAuthSource: (value) => { source = value; },
    getUserProvidedPassword: () => null,
    syncToHmrState,
  });
  return {
    processLike,
    runtime,
    syncToHmrState,
    getState: () => ({ password, source }),
  };
};

describe('OpenCode auth state runtime', () => {
  it('restores the previous password after a managed rotation rollback', async () => {
    const fixture = createFixture();
    const restore = fixture.runtime.captureOpenCodeAuthState();

    const rotated = await fixture.runtime.ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    expect(rotated).not.toBe('old-password');
    expect(fixture.getState()).toEqual({ password: rotated, source: 'rotated' });
    expect(fixture.processLike.env.OPENCODE_SERVER_PASSWORD).toBe(rotated);

    restore();

    expect(fixture.getState()).toEqual({ password: 'old-password', source: 'generated' });
    expect(fixture.processLike.env.OPENCODE_SERVER_PASSWORD).toBe('old-password');
    expect(fixture.runtime.getOpenCodeAuthHeaders()).toEqual({
      Authorization: `Basic ${Buffer.from('opencode:old-password').toString('base64')}`,
    });
    expect(fixture.syncToHmrState).toHaveBeenCalled();
  });
});
