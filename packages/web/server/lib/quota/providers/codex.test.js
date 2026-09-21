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

  it('surfaces spend_control individual limit for business accounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'business',
        rate_limit: null,
        credits: { has_credits: true, unlimited: false, balance: null },
        spend_control: {
          individual_limit: {
            limit: '7500',
            used: '2674.8724080324173',
            remaining: '4825.127591967583',
            used_percent: 36,
            remaining_percent: 64
          }
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits.usedPercent).toBe(36);
    expect(result.usage.windows.credits.valueLabel).toBe('2675 / 7500 used');
    expect(fetchMock).toHaveBeenCalled();
  });
});
