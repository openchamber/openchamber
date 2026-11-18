import type { QuotaResult, QuotaResultInput, ResetTimestamp, UsageWindow, UsageWindowInput } from './contracts.js';

export const formatResetTime = (timestamp: ResetTimestamp) => {
  try {
    const resetDate = new Date(timestamp);
    if (!Number.isFinite(resetDate.getTime())) {
      return null;
    }

    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();
    
    if (isToday) {
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      });
    }
    
    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return null;
  }
};

const hasResetTimestamp = (resetAt: ResetTimestamp | null | undefined): resetAt is ResetTimestamp => resetAt !== null && resetAt !== undefined && resetAt !== '';

export const calculateResetAfterSeconds = (resetAt: ResetTimestamp | null | undefined) => {
  if (!hasResetTimestamp(resetAt)) return null;
  const resetAtTime = new Date(resetAt).getTime();
  if (!Number.isFinite(resetAtTime)) return null;
  const delta = Math.floor((resetAtTime - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
};

export const toUsageWindow = ({ usedPercent, windowSeconds, resetAt, valueLabel, creditsUsed }: UsageWindowInput): UsageWindow => {
  const resetAfterSeconds = calculateResetAfterSeconds(resetAt);
  const resetFormatted = hasResetTimestamp(resetAt) ? formatResetTime(resetAt) : null;
  const hasFiniteUsedPercent = usedPercent !== null && usedPercent !== undefined && Number.isFinite(usedPercent);
  const window: UsageWindow = {
    usedPercent,
    remainingPercent: hasFiniteUsedPercent ? Math.max(0, 100 - usedPercent) : null,
    windowSeconds: windowSeconds ?? null,
    resetAfterSeconds,
    resetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted
  };
  if (valueLabel) window.valueLabel = valueLabel;
  if (creditsUsed !== undefined) window.creditsUsed = creditsUsed;
  return window;
};

export const buildResult = <ProviderId extends string | null, ProviderName extends string | null>({ providerId, providerName, ok, configured, usage, error, planLabel, accountLabel }: QuotaResultInput<ProviderId, ProviderName>): QuotaResult<ProviderId, ProviderName> => {
  const result: QuotaResult<ProviderId, ProviderName> = { providerId, providerName, ok, configured, usage: usage ?? null, fetchedAt: Date.now() };
  if (error) result.error = error;
  if (planLabel) result.planLabel = planLabel;
  if (accountLabel) result.accountLabel = accountLabel;
  return result;
};

export const durationToLabel = (duration: number | null | undefined, unit: string | null | undefined) => {
  if (!duration || !unit) return 'limit';
  if (unit === 'TIME_UNIT_MINUTE') return `${duration}m`;
  if (unit === 'TIME_UNIT_HOUR') return `${duration}h`;
  if (unit === 'TIME_UNIT_DAY') return `${duration}d`;
  return 'limit';
};

export const durationToSeconds = (duration: number | null | undefined, unit: string | null | undefined) => {
  if (!duration || !unit) return null;
  if (unit === 'TIME_UNIT_MINUTE') return duration * 60;
  if (unit === 'TIME_UNIT_HOUR') return duration * 3600;
  if (unit === 'TIME_UNIT_DAY') return duration * 86400;
  return null;
};

export const formatMoney = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};

export const formatCredits = (value: number) => {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded)
    ? rounded.toLocaleString('en-US')
    : rounded.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
};
