import { describe, expect, it } from 'vitest';

import { toClaudeUsage } from './transforms.js';

// Trimmed capture of GET https://api.anthropic.com/api/oauth/usage for a Max account.
const LIVE_PAYLOAD = {
  five_hour: { utilization: 5.0, resets_at: '2026-08-14T19:10:00.313090+00:00' },
  seven_day: { utilization: 4.0, resets_at: '2026-08-20T15:00:00.313112+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  limits: [
    { kind: 'session', group: 'session', percent: 5, resets_at: '2026-08-14T19:10:00.313090+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 4, resets_at: '2026-08-20T15:00:00.313112+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 12,
      resets_at: '2026-08-20T15:00:00.313301+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false
    }
  ],
  spend: {
    used: { amount_minor: 250, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
    percent: 2.5,
    enabled: true
  }
};

describe('Claude usage transforms', () => {
  it('maps the limits array to session, weekly, and model-scoped windows', () => {
    const { windows, models } = toClaudeUsage(LIVE_PAYLOAD);

    expect(windows['5h'].usedPercent).toBe(5);
    expect(windows['5h'].resetAt).toBe(Date.parse('2026-08-14T19:10:00.313090+00:00'));
    expect(windows['7d'].usedPercent).toBe(4);
    expect(models.Fable.windows['7d'].usedPercent).toBe(12);
  });

  it('reports each window duration so callers can rank limits by urgency', () => {
    const { windows, models } = toClaudeUsage(LIVE_PAYLOAD);

    expect(windows['5h'].windowSeconds).toBe(5 * 60 * 60);
    expect(windows['7d'].windowSeconds).toBe(7 * 24 * 60 * 60);
    expect(models.Fable.windows['7d'].windowSeconds).toBe(7 * 24 * 60 * 60);
    expect(windows.extra_usage.windowSeconds).toBeNull();
  });

  it('reports extra usage as a spend window with a money label', () => {
    const { windows } = toClaudeUsage(LIVE_PAYLOAD);

    expect(windows.extra_usage.usedPercent).toBe(2.5);
    expect(windows.extra_usage.valueLabel).toBe('$2.50 / $100.00');
  });

  it('omits extra usage when the account has it disabled', () => {
    const { windows } = toClaudeUsage({ ...LIVE_PAYLOAD, spend: { ...LIVE_PAYLOAD.spend, enabled: false } });

    expect(windows.extra_usage).toBeUndefined();
  });

  it('falls back to the legacy named fields when no limits array is present', () => {
    const { windows, models } = toClaudeUsage({ five_hour: LIVE_PAYLOAD.five_hour, seven_day: LIVE_PAYLOAD.seven_day });

    expect(windows['5h'].usedPercent).toBe(5);
    expect(windows['7d'].usedPercent).toBe(4);
    expect(models).toEqual({});
  });

  it('ignores unknown limit kinds instead of inventing windows for them', () => {
    const { windows } = toClaudeUsage({ limits: [{ kind: 'iguana_necktie', percent: 90, resets_at: null }] });

    expect(windows).toEqual({});
  });

  it('returns empty usage for a malformed payload', () => {
    expect(toClaudeUsage(null)).toEqual({ windows: {}, models: {} });
    expect(toClaudeUsage({ limits: 'nope' })).toEqual({ windows: {}, models: {} });
  });
});
