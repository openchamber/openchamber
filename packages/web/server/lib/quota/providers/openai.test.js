import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authModule from '../../opencode/auth.js';
import { fetchQuota } from './openai.js';

// Canonical (mystatus.ts OpenAIWindowData) exposes `reset_after_seconds`
// (RELATIVE seconds until reset), NOT an absolute `reset_at` timestamp.
// The provider must convert it to an absolute resetAt = now + secs*1000.
describe('openai quota provider — reset_after_seconds fidelity', () => {
  let fetchSpy;
  let authSpy;

  beforeEach(() => {
    authSpy = vi.spyOn(authModule, 'readAuthFile').mockReturnValue({
      openai: { type: 'oauth', access: 'fake-access-token' },
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps primary/secondary reset_after_seconds to an absolute resetAt', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: {
            used_percent: 60,
            limit_window_seconds: 18000,
            reset_after_seconds: 3600,
          },
          secondary_window: {
            used_percent: 20,
            limit_window_seconds: 604800,
            reset_after_seconds: 86400,
          },
        },
      }),
    });

    const before = Date.now();
    const result = await fetchQuota();
    const after = Date.now();

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({ method: 'GET' }),
    );

    const primary = result.usage.windows['5h'];
    expect(primary.usedPercent).toBe(60);
    expect(primary.remainingPercent).toBe(40);
    // resetAt must be ~ now + 3600s, NOT a bogus reset_at*1000.
    expect(primary.resetAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(primary.resetAt).toBeLessThanOrEqual(after + 3600 * 1000);

    const weekly = result.usage.windows.weekly;
    expect(weekly.usedPercent).toBe(20);
    expect(weekly.resetAt).toBeGreaterThanOrEqual(before + 86400 * 1000);
    expect(weekly.resetAt).toBeLessThanOrEqual(after + 86400 * 1000);
  });

  it('leaves resetAt null when reset_after_seconds is absent', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18000 },
        },
      }),
    });

    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].resetAt).toBeNull();
  });

  it('returns configured:false when no auth token is present', async () => {
    authSpy.mockReturnValue({});
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
  });
});
