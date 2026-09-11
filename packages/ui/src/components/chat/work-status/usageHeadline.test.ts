import { describe, expect, test } from 'bun:test';
import { pickUsageHeadline, resolveQuotaProviderId } from './usageHeadline';
import type { UsageProviderGroup } from '@/components/usage/usageGroups';

const HOUR = 3600;

const window = (windowSeconds: number | null) => ({
  usedPercent: 10,
  remainingPercent: 90,
  windowSeconds,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const group = (providerId: string, rows: Array<{ key: string; label: string; subtitle?: string; seconds: number | null }>): UsageProviderGroup => ({
  providerId: providerId as UsageProviderGroup['providerId'],
  providerName: providerId,
  status: null,
  accounts: [],
  rows: rows.map((row) => ({
    key: row.key,
    label: row.label,
    subtitle: row.subtitle,
    window: window(row.seconds),
  })),
});

describe('resolveQuotaProviderId', () => {
  test('passes through ids that already match a quota provider', () => {
    expect(resolveQuotaProviderId('opencode-go')).toBe('opencode-go');
  });

  test('maps the known divergences', () => {
    expect(resolveQuotaProviderId('openai')).toBe('codex');
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
  });

  test('maps the opencode-claude integration provider onto Claude quota', () => {
    expect(resolveQuotaProviderId('claude-code')).toBe('claude');
  });

  test('is case and whitespace tolerant, and rejects empties', () => {
    expect(resolveQuotaProviderId('  OpenAI ')).toBe('codex');
    expect(resolveQuotaProviderId('')).toBeNull();
    expect(resolveQuotaProviderId(null)).toBeNull();
  });
});

describe('pickUsageHeadline', () => {
  const groups = [
    group('codex', [{ key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR }]),
    group('opencode-go', [
      { key: 'm', label: 'Monthly Limit', seconds: 30 * 24 * HOUR },
      { key: 'h', label: '5-Hour', seconds: 5 * HOUR },
      { key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ]),
  ];

  test('picks the shortest window of the matching provider', () => {
    // The tightest bucket is the one that decides whether the next turn lands.
    expect(pickUsageHeadline(groups, 'opencode-go')?.row.label).toBe('5-Hour');
  });

  test('resolves the provider through the alias table', () => {
    expect(pickUsageHeadline(groups, 'openai')?.group.providerId).toBe('codex');
  });

  test('returns null when no group matches the composer provider', () => {
    // Showing another provider's quota would read as the active one.
    expect(pickUsageHeadline(groups, 'mistral')).toBeNull();
    expect(pickUsageHeadline(groups, null)).toBeNull();
  });

  test('ignores model-scoped rows while any provider-level row exists', () => {
    const scoped = [group('zai-coding-plan', [
      { key: 'model', label: '5-Hour', subtitle: 'GLM-5', seconds: 5 * HOUR },
      { key: 'provider', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ])];
    expect(pickUsageHeadline(scoped, 'zai-coding-plan')?.row.label).toBe('Weekly Limit');
  });

  test('falls back to a durationless row when nothing reports a window', () => {
    const balances = [group('codex', [{ key: 'credits', label: 'Credits Balance', seconds: null }])];
    expect(pickUsageHeadline(balances, 'codex')?.row.label).toBe('Credits Balance');
  });

  test('prefers any real window over a durationless row', () => {
    const mixed = [group('codex', [
      { key: 'credits', label: 'Credits Balance', seconds: null },
      { key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ])];
    expect(pickUsageHeadline(mixed, 'codex')?.row.label).toBe('Weekly Limit');
  });

  test('returns null for a matched provider that reported no rows', () => {
    expect(pickUsageHeadline([group('codex', [])], 'codex')).toBeNull();
  });

  test('uses the shortest window from the current available account', () => {
    const multi = group('codex', []);
    multi.accounts = [
      { id: 'one', label: 'One', current: false, available: true, rows: [{ key: 'one-5h', label: '5-Hour', window: window(5 * HOUR) }] },
      { id: 'two', label: 'Two', current: true, available: true, rows: [
        { key: 'two-weekly', label: 'Weekly Limit', window: window(7 * 24 * HOUR) },
        { key: 'two-5h', label: '5-Hour', window: window(5 * HOUR) },
      ] },
    ];
    expect(pickUsageHeadline([multi], 'openai')?.row.key).toBe('two-5h');
  });

  test('does not present a benched current account as active', () => {
    const multi = group('codex', []);
    multi.accounts = [{
      id: 'one',
      label: 'One',
      current: true,
      available: false,
      status: 'Benched here',
      rows: [{ key: 'one-5h', label: '5-Hour', window: window(5 * HOUR) }],
    }];
    expect(pickUsageHeadline([multi], 'openai')).toBeNull();
  });
});
