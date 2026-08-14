import { describe, expect, test } from 'bun:test';
import type { ProviderResult } from '@/types';
import {
  getProviderRemainingDisplay,
  isIncludedUsageProvider,
  isVisibleUsageProvider,
} from './usageProviderHelpers';

describe('isIncludedUsageProvider', () => {
  test('includes quota-configured providers', () => {
    expect(isIncludedUsageProvider('claude', { configured: true })).toBe(true);
  });

  test('includes auth-configured providers from /api/quota/providers', () => {
    expect(isIncludedUsageProvider('kimi-for-coding', {
      configured: false,
      authConfiguredQuotaProviderIds: new Set(['kimi-for-coding', 'zai-coding-plan']),
    })).toBe(true);
  });

  test('includes OpenCode-connected providers mapped to quota IDs', () => {
    expect(isIncludedUsageProvider('google', {
      configured: false,
      connectedQuotaProviderIds: new Set(['google', 'github-copilot']),
    })).toBe(true);
  });

  test('excludes providers that are neither configured nor connected', () => {
    expect(isIncludedUsageProvider('claude', {
      configured: false,
      authConfiguredQuotaProviderIds: new Set(['google']),
      connectedQuotaProviderIds: new Set(['google']),
    })).toBe(false);
  });
});

describe('isVisibleUsageProvider', () => {
  test('shows configured providers by default', () => {
    expect(isVisibleUsageProvider('claude', {
      configured: true,
      hiddenProviderIds: [],
    })).toBe(true);
  });

  test('shows auth-configured plugin providers even when fetch is not configured', () => {
    expect(isVisibleUsageProvider('zai-coding-plan', {
      configured: false,
      authConfiguredQuotaProviderIds: ['zai-coding-plan'],
      hiddenProviderIds: [],
    })).toBe(true);
  });

  test('shows connected providers even when quota is not configured', () => {
    expect(isVisibleUsageProvider('github-copilot', {
      configured: false,
      connectedQuotaProviderIds: ['github-copilot'],
      hiddenProviderIds: [],
    })).toBe(true);
  });

  test('hides included providers on the denylist', () => {
    expect(isVisibleUsageProvider('claude', {
      configured: true,
      hiddenProviderIds: ['claude'],
    })).toBe(false);
    expect(isVisibleUsageProvider('google', {
      configured: false,
      connectedQuotaProviderIds: new Set(['google']),
      hiddenProviderIds: new Set(['google']),
    })).toBe(false);
  });

  test('never shows providers that are neither configured nor connected', () => {
    expect(isVisibleUsageProvider('claude', {
      configured: false,
      authConfiguredQuotaProviderIds: [],
      connectedQuotaProviderIds: [],
      hiddenProviderIds: [],
    })).toBe(false);
  });
});

describe('getProviderRemainingDisplay', () => {
  const usage = (
    windows: NonNullable<ProviderResult['usage']>['windows'],
  ): ProviderResult['usage'] => ({ windows });

  test('prefers remaining percent when available', () => {
    expect(getProviderRemainingDisplay(usage({
      '5h': {
        usedPercent: 40,
        remainingPercent: 60,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: '$12.00',
      },
    }))).toEqual({ kind: 'percent', percent: 60 });
  });

  test('falls back to cost valueLabel when percent is unavailable', () => {
    expect(getProviderRemainingDisplay(usage({
      credits: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: '$12.35',
      },
    }))).toEqual({ kind: 'amount', label: '$12.35' });
  });

  test('prefers credits_balance window for cost remaining', () => {
    expect(getProviderRemainingDisplay(usage({
      other: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: 'ignore',
      },
      credits_balance: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: '$32.68',
      },
    }))).toEqual({ kind: 'amount', label: '$32.68' });
  });

  test('returns null when neither percent nor valueLabel exists', () => {
    expect(getProviderRemainingDisplay(usage({}))).toBeNull();
    expect(getProviderRemainingDisplay(null)).toBeNull();
  });
});
