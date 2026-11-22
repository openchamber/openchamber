import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RESUME_IDLE_TIMEOUT_MS,
  DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  OPENCODE_SSE_HEARTBEAT_INTERVAL_MS,
  resolveEventStreamTimeouts,
  UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS,
} from './timeouts.js';

const DEFAULTS = {
  stallTimeoutMs: 20_000,
  concurrentStallTimeoutMs: 40_000,
  resumeIdleTimeoutMs: 10_000,
};

describe('event stream timing windows', () => {
  it('defaults to a 20 s stall window, 40 s while sessions run concurrently, and a 10 s resume idle bound', () => {
    expect(DEFAULT_UPSTREAM_STALL_TIMEOUT_MS).toBe(20_000);
    expect(UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS).toBe(40_000);
    expect(DEFAULT_RESUME_IDLE_TIMEOUT_MS).toBe(10_000);
    // An idle OpenCode stream is silent between heartbeats; the stall window must outlast that gap.
    expect(DEFAULT_UPSTREAM_STALL_TIMEOUT_MS).toBeGreaterThan(OPENCODE_SSE_HEARTBEAT_INTERVAL_MS);

    const warn = vi.fn();
    expect(resolveEventStreamTimeouts({}, warn)).toEqual(DEFAULTS);
    // A blank variable is unset, not invalid.
    expect(resolveEventStreamTimeouts({
      OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_MS: ' ',
      OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS: '',
      OPENCHAMBER_RESUME_IDLE_TIMEOUT_MS: '',
    }, warn)).toEqual(DEFAULTS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('takes each window from its own environment variable', () => {
    const warn = vi.fn();
    expect(resolveEventStreamTimeouts({
      OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_MS: '15000',
      OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS: ' 45000 ',
      OPENCHAMBER_RESUME_IDLE_TIMEOUT_MS: '4000',
    }, warn)).toEqual({
      stallTimeoutMs: 15_000,
      concurrentStallTimeoutMs: 45_000,
      resumeIdleTimeoutMs: 4_000,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the default for each window whose variable is invalid, and warns once for it', () => {
    const invalid = ['abc', '0', '-5', '12.5', '999', '600001', '1e99', '1e3', '0x4E20', '20000.0', '+20000', '20000junk', '5.9'];
    for (const name of [
      'OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_MS',
      'OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS',
      'OPENCHAMBER_RESUME_IDLE_TIMEOUT_MS',
    ]) {
      for (const value of invalid) {
        const warn = vi.fn();
        const resolved = resolveEventStreamTimeouts({ [name]: value }, warn);
        expect(resolved).toEqual(DEFAULTS);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(`${name}=${JSON.stringify(value)}`);
      }
    }
  });

  it('keeps a valid window and falls back only on the invalid one', () => {
    const warn = vi.fn();
    expect(resolveEventStreamTimeouts({
      OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_MS: 'soon',
      OPENCHAMBER_RESUME_IDLE_TIMEOUT_MS: '30000',
    }, warn)).toEqual({ ...DEFAULTS, resumeIdleTimeoutMs: 30_000 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
