import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { formatDateTimeForPreference, formatTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';

const t = (key: Parameters<typeof formatMessage>[1]) => formatMessage(useI18nStore.getState().dictionary, key);

export const clampPercent = (value: number | null): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
};

export const formatPercent = (value: number | null): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  return `${Math.round(value)}%`;
};

export const formatQuotaValueLabel = (
  valueLabel: string | null | undefined,
  percent: number | null,
): string => {
  return valueLabel ?? formatPercent(percent);
};

export const formatQuotaResetLabel = (
  resetAt: number | null,
  fallback?: string | null,
  timeFormatPreference: TimeFormatPreference = 'auto',
): string => {
  if (!resetAt) {
    return fallback ?? '';
  }

  try {
    const resetDate = new Date(resetAt);
    if (!Number.isFinite(resetDate.getTime())) {
      return fallback ?? '';
    }

    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();

    if (isToday) {
      return formatTimeForPreference(resetDate, timeFormatPreference, { fallback: fallback ?? '' });
    }

    return formatDateTimeForPreference(resetDate, timeFormatPreference, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return fallback ?? '';
  }
};

export const resolveUsageTone = (percent: number | null): 'safe' | 'warn' | 'critical' => {
  if (percent === null) {
    return 'safe';
  }
  if (percent >= 80) {
    return 'critical';
  }
  if (percent >= 50) {
    return 'warn';
  }
  return 'safe';
};

export const formatWindowLabel = (label: string): string => {
  if (label === '5h') return t('quota.window.5h');
  if (label === '7d') return t('quota.window.7d');
  if (label === 'extra_usage') return t('quota.window.extraUsage');
  if (label === 'weekly') return t('quota.window.weekly');
  if (label === 'daily') return t('quota.window.daily');
  if (label === 'monthly') return t('quota.window.monthly');
  if (label === 'credits') return t('quota.window.credits');
  if (label === 'credits_balance') return t('quota.window.creditsBalance');
  if (label === 'billing_cycle') return t('quota.window.billingCycle');
  if (label === 'plan_limit') return t('quota.window.planLimit');
  if (label === 'auto') return t('quota.window.auto');
  if (label === 'api') return t('quota.window.api');
  if (label === 'plan_limit') return t('quota.window.planLimit');
  if (label === 'on_demand') return t('quota.window.onDemand');
  if (label === 'session') return t('quota.window.session');
  if (label === 'premium') return t('quota.window.premium');
  if (label === 'chat') return t('quota.window.chat');
  if (label === 'completions') return t('quota.window.completions');
  if (label === 'premium_interactions') return t('quota.window.premiumInteractions');
  return label;
};
