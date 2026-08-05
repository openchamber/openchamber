import { describe, expect, it } from 'vitest';

import { resolveControlTimeoutMs } from './cli-control.js';

describe('resolveControlTimeoutMs', () => {
  it('keeps the short default HTTP timeout for instant control calls', () => {
    expect(resolveControlTimeoutMs({}, {})).toBeUndefined();
    expect(resolveControlTimeoutMs({ wait: false, timeout: 30 }, {})).toBeUndefined();
  });

  it('outlives the default server wait window when wait is set', () => {
    expect(resolveControlTimeoutMs({ wait: true }, {})).toBe(630_000);
  });

  it('derives the HTTP timeout from an explicit wait timeout in seconds', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30 }, {})).toBe(60_000);
  });

  it('never shrinks an explicitly requested HTTP timeout', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30 }, { timeoutMs: 5000 })).toBe(5000);
  });

  it('allows a worktree to be provisioned without waiting for the session', () => {
    expect(resolveControlTimeoutMs({ worktree: 'feature' }, {})).toBe(120_000);
  });

  it('ignores a blank worktree name', () => {
    expect(resolveControlTimeoutMs({ worktree: '   ' }, {})).toBeUndefined();
  });

  it('covers provisioning and waiting in sequence when both are requested', () => {
    // The server creates the worktree before it begins waiting for the session,
    // so the client window must span both rather than the longer of the two.
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30, worktree: 'feature' }, {})).toBe(180_000);
    expect(resolveControlTimeoutMs({ wait: true, worktree: 'feature' }, {})).toBe(750_000);
  });
});
