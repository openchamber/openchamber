import { describe, expect, test } from 'bun:test';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { ProviderResult, UsageWindow } from '@/types';
import { createWidgetUsageSnapshot, type WidgetQuotaInput } from './widgetUsageSnapshot';

const quotaWindow = (
  used: number | null,
  remaining: number | null,
  valueLabel?: string,
  resetAt?: number,
): UsageWindow => ({
  usedPercent: used,
  remainingPercent: remaining,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: resetAt ?? null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  valueLabel,
});

const provider = (
  id: ProviderResult['providerId'],
  name: string,
  windows: Record<string, UsageWindow>,
): ProviderResult => ({
  providerId: id,
  providerName: name,
  ok: true,
  configured: true,
  fetchedAt: 1,
  usage: { windows },
});

const data: WidgetQuotaInput = {
  displayMode: 'remaining',
  dropdownProviderIds: ['cursor', 'github-copilot', 'codex', 'ext-antigravity-usage'],
  selectedModels: {},
  results: [
    provider('cursor', 'Cursor Pro', {
      'Cursor Models': quotaWindow(0, 100, undefined, 1_800_000_000_000),
      'Other Models': quotaWindow(0, 100),
    }),
    provider('github-copilot', 'GitHub Copilot', {
      premium_interactions: quotaWindow(1.1, 98.9, '2.2 / 200 used', 1_800_000_000_000),
    }),
    provider('codex', 'Codex', {
      '5h': quotaWindow(32, 68),
      weekly: quotaWindow(21, 79),
      credits_balance: quotaWindow(null, null, '0'),
    }),
    provider('ext-antigravity-usage', 'Antigravity', {
      'Google models · 5-Hour': quotaWindow(0, 100),
      'Google models · Weekly': quotaWindow(1, 99),
      'Non-Google models · 5-Hour': quotaWindow(0, 100),
      'Non-Google models · Weekly': quotaWindow(0, 100),
    }),
  ],
};

// Keys with their params, so the test sees which page text each value came from.
const format = {
  t: (key: I18nKey, params?: I18nParams) => (params ? `${key} ${JSON.stringify(params)}` : key),
  timeFormatPreference: '24h' as const,
};
const snapshotOf = (input: WidgetQuotaInput) => createWidgetUsageSnapshot(input, format);

describe('Android Usage widgets from built-in quota state', () => {
  test('keeps selected provider order and provider-defined windows', () => {
    const snapshot = snapshotOf(data);
    expect(snapshot.providers.map((group) => group.name)).toEqual([
      'Cursor Pro', 'GitHub Copilot', 'Codex', 'Antigravity',
    ]);
    expect(snapshot.providers[3]?.windows.map((row) => row.label)).toEqual([
      'Google models · 5-Hour', 'Google models · Weekly',
      'Non-Google models · 5-Hour', 'Non-Google models · Weekly',
    ]);
  });

  test('shows the provider count the Usage page shows, the bar share and a reset text', () => {
    const copilot = snapshotOf(data).providers[1]?.windows[0];
    expect(copilot).toMatchObject({ value: '2.2 / 200 used', percent: 98.9, tone: 'safe' });
    expect(copilot?.reset?.startsWith('settings.usage.card.resetsAt')).toBe(true);
  });

  test('a balance has its value and no bar', () => {
    const balance = snapshotOf(data).providers[2]?.windows[2];
    expect(balance?.value).toBe('0');
    expect(balance?.percent).toBeUndefined();
  });

  test('colors by the used share in both display modes', () => {
    const codex = snapshotOf(data).providers[2]?.windows;
    expect(codex?.[0]).toMatchObject({ percent: 68, tone: 'safe' });
    const used = snapshotOf({ ...data, displayMode: 'usage', dropdownProviderIds: ['codex'] });
    expect(used.mode).toBe('used');
    expect(used.providers[0]?.windows[0]).toMatchObject({ percent: 32, tone: 'safe' });
  });

  test('honors hidden providers and selected models for model-scoped windows', () => {
    const google = provider('google', 'Google', {});
    google.usage = {
      windows: {},
      models: {
        'gemini/flash': { windows: { '5h': quotaWindow(4, 96) } },
        'gemini/pro': { windows: { weekly: quotaWindow(5, 95) } },
      },
    };
    const snapshot = snapshotOf({
      ...data,
      dropdownProviderIds: ['google'],
      selectedModels: { google: ['gemini/pro'] },
      results: [google],
    });
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]?.windows).toHaveLength(1);
    expect(snapshot.providers[0]?.windows[0]?.label).toContain('gemini/pro');
  });
});
