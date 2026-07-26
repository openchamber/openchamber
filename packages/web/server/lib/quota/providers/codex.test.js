import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ openai: { access: 'test-token' } }),
}));

import { fetchQuota } from './codex.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockUsage = (rateLimit) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rate_limit: rateLimit }),
  }));
};

describe('Codex quota windows', () => {
  it('labels a weekly-only primary window from its duration', async () => {
    mockUsage({
      primary_window: {
        used_percent: 3,
        limit_window_seconds: 604800,
        reset_at: 1784491827,
      },
      secondary_window: null,
    });

    const result = await fetchQuota();

    expect(result.usage.windows.weekly.usedPercent).toBe(3);
    expect(result.usage.windows['5h']).toBeUndefined();
  });

  it('labels five-hour and weekly windows from their durations', async () => {
    mockUsage({
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    });

    const result = await fetchQuota();

    expect(result.usage.windows['5h'].usedPercent).toBe(10);
    expect(result.usage.windows.weekly.usedPercent).toBe(20);
  });
});
