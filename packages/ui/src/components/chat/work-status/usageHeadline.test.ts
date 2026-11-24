import { describe, expect, test } from 'bun:test';
import { pickUsageHeadline, resolveQuotaProviderId } from './usageHeadline';
import type { UsageProviderGroup } from '@/components/usage/usageGroups';

const HOUR = 3600;

const window = (windowSeconds: number | null, usedPercent: number | null = 10, valueLabel?: string) => ({
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  windowSeconds,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  valueLabel: valueLabel ?? null,
});

const group = (
  providerId: string,
  rows: Array<{ key: string; label: string; subtitle?: string; seconds: number | null; used?: number | null; valueLabel?: string }>,
  providers: string[] = [],
): UsageProviderGroup => ({
  providerId: providerId as UsageProviderGroup['providerId'],
  providerName: providerId,
  providers,
  status: null,
  rows: rows.map((row) => ({
    key: row.key,
    label: row.label,
    subtitle: row.subtitle,
    window: window(row.seconds, row.used === undefined ? 10 : row.used, row.valueLabel),
  })),
});

describe('resolveQuotaProviderId', () => {
  test('passes through ids that already match a quota provider', () => {
    expect(resolveQuotaProviderId('opencode-go')).toBe('opencode-go');
    // The OpenCode Console workspace serves its models under `opencode`, and
    // the Zen quota card carries that id.
    expect(resolveQuotaProviderId('opencode')).toBe('opencode');
  });

  test('maps the known divergences', () => {
    expect(resolveQuotaProviderId('openai')).toBe('codex');
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
    expect(resolveQuotaProviderId('kilocode')).toBe('kilo');
    expect(resolveQuotaProviderId('kilo-code')).toBe('kilo');
  });

  test('maps both Claude Code providers onto Claude quota', () => {
    expect(resolveQuotaProviderId('claude-agent')).toBe('claude');
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

  test('keeps a lifetime cap ahead of monthly spending rows', () => {
    const openrouter = group('openrouter', [
      { key: 'window-monthly_total', label: 'Monthly Total', seconds: 30 * 24 * HOUR, used: null },
      { key: 'window-monthly_credits', label: 'Monthly Credits', seconds: null, used: null },
      { key: 'window-monthly_byok', label: 'Monthly BYOK', seconds: null, used: null },
      { key: 'window-key_limit', label: 'Key Limit', seconds: null, used: null, valueLabel: '$5.00 / $30.00' },
    ]);

    expect(pickUsageHeadline([openrouter], 'openrouter')?.row.key).toBe('window-key_limit');
  });

  test('keeps a monthly cap ahead of the monthly total with the same duration', () => {
    const openrouter = group('openrouter', [
      { key: 'window-monthly', label: 'Monthly', seconds: 30 * 24 * HOUR, used: 40 },
      { key: 'window-monthly_total', label: 'Monthly Total', seconds: 30 * 24 * HOUR, used: null },
      { key: 'window-monthly_credits', label: 'Monthly Credits', seconds: null, used: null },
      { key: 'window-monthly_byok', label: 'Monthly BYOK', seconds: null, used: null },
    ]);

    expect(pickUsageHeadline([openrouter], 'openrouter')?.row.key).toBe('window-monthly');
  });

  test('keeps a set cap with an unreadable amount ahead of the monthly total', () => {
    const openrouter = group('openrouter', [
      { key: 'window-monthly_total', label: 'Monthly Total', seconds: 30 * 24 * HOUR, used: null },
      { key: 'window-key_limit', label: 'Key Limit', seconds: null, used: null },
    ]);
    openrouter.rows[1]!.window.value = { kind: 'spend', spent: null, limit: 30 };

    expect(pickUsageHeadline([openrouter], 'openrouter')?.row.key).toBe('window-key_limit');
  });

  test('falls back to the monthly total when an OpenRouter key has no cap', () => {
    const openrouter = group('openrouter', [
      { key: 'window-monthly_total', label: 'Monthly Total', seconds: 30 * 24 * HOUR, used: null },
      { key: 'window-monthly_credits', label: 'Monthly Credits', seconds: 30 * 24 * HOUR, used: null },
      { key: 'window-monthly_byok', label: 'Monthly BYOK', seconds: 30 * 24 * HOUR, used: null },
    ]);

    expect(pickUsageHeadline([openrouter], 'openrouter')?.row.key).toBe('window-monthly_total');
  });

  test('shows the readable OpenRouter counter under its own label when the total is unknown', () => {
    // An uncapped key whose gateway omits the BYOK counter: the total stays unknown,
    // and the headline shows the credits it can read instead of "Unknown".
    const openrouter = group('openrouter', [
      { key: 'window-monthly_total', label: 'Monthly Total', seconds: 30 * 24 * HOUR, used: null },
      { key: 'window-monthly_credits', label: 'Monthly Credits', seconds: null, used: null },
    ]);
    openrouter.rows[0]!.window.value = { kind: 'spend', spent: null, limit: null };
    openrouter.rows[1]!.window.value = { kind: 'spend', spent: 3.17561396, limit: null };

    expect(pickUsageHeadline([openrouter], 'openrouter')?.row.key).toBe('window-monthly_credits');
  });

  test('keeps the generic selection for another provider with a monthly_total window', () => {
    // The quota SDK lets an extension name a window `monthly_total`; that name is not reserved.
    const extension = group('ext-quota', [
      { key: 'window-daily', label: 'Daily', seconds: 24 * HOUR, used: null },
      { key: 'window-monthly_total', label: 'Monthly Total', seconds: 30 * 24 * HOUR, used: null },
    ]);
    extension.rows[0]!.window.value = { kind: 'requests', count: 12 };
    extension.rows[1]!.window.value = { kind: 'requests', count: 300 };

    expect(pickUsageHeadline([extension], 'ext-quota')?.row.key).toBe('window-daily');
  });

  test('resolves an extension group through its declared providers', () => {
    const ext = group('ext-xiaomi-quota', [{ key: 'credits', label: 'Credits Balance', seconds: null }], ['xiaomi']);
    expect(pickUsageHeadline([ext], 'xiaomi')?.group.providerId).toBe('ext-xiaomi-quota');
    expect(pickUsageHeadline([ext], 'xiaomi')?.row.label).toBe('Credits Balance');
  });

  test('prefers a built-in group over an extension that also declares the provider', () => {
    const builtin = group('deepseek', [{ key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR }]);
    const ext = group('ext-deepseek-usage', [{ key: 'credits', label: 'Credits Balance', seconds: null }], ['deepseek']);
    expect(pickUsageHeadline([builtin, ext], 'deepseek')?.group.providerId).toBe('deepseek');
  });

  test('leaves an extension that declares several credentials out of the headline', () => {
    const ext = group('ext-multi-usage', [{ key: 'credits', label: 'Credits Balance', seconds: null }], ['openrouter', 'deepinfra']);
    expect(pickUsageHeadline([ext], 'deepinfra')).toBeNull();
  });

  test('matches extension declarations by the exact provider id, not a built-in alias', () => {
    const google = group('ext-google-usage', [{ key: 'g', label: 'Google Daily', seconds: 24 * HOUR }], ['google']);
    const gemini = group('ext-gemini-usage', [{ key: 'd', label: 'Daily', seconds: 24 * HOUR }], ['gemini']);
    expect(pickUsageHeadline([google, gemini], 'gemini')?.group.providerId).toBe('ext-gemini-usage');
    expect(pickUsageHeadline([group('ext-claude-usage', [{ key: 'd', label: 'Daily', seconds: 24 * HOUR }], ['claude'])], 'anthropic')).toBeNull();
  });

  test('skips a declaring extension with no rows for the next one that has a balance', () => {
    const failed = group('ext-xiaomi-a', [], ['xiaomi']);
    const working = group('ext-xiaomi-b', [{ key: 'credits', label: 'Credits Balance', seconds: null }], ['xiaomi']);
    expect(pickUsageHeadline([failed, working], 'xiaomi')?.group.providerId).toBe('ext-xiaomi-b');
    expect(pickUsageHeadline([failed], 'xiaomi')).toBeNull();
  });

  test('skips a declaring extension whose rows have nothing to show', () => {
    const blank = group('ext-xiaomi-a', [{ key: 'daily', label: 'Daily', seconds: 24 * HOUR, used: null }], ['xiaomi']);
    const working = group('ext-xiaomi-b', [{ key: 'credits', label: 'Credits Balance', seconds: null, used: null, valueLabel: '$4.20' }], ['xiaomi']);
    expect(pickUsageHeadline([blank, working], 'xiaomi')?.row.label).toBe('Credits Balance');
    expect(pickUsageHeadline([blank], 'xiaomi')).toBeNull();
  });
});
