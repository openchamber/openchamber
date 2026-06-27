export const formatResetTime = (timestamp) => {
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

const hasResetTimestamp = (resetAt) => resetAt !== null && resetAt !== undefined && resetAt !== '';

export const calculateResetAfterSeconds = (resetAt) => {
  if (!hasResetTimestamp(resetAt)) return null;
  const resetAtTime = new Date(resetAt).getTime();
  if (!Number.isFinite(resetAtTime)) return null;
  const delta = Math.floor((resetAtTime - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
};

export const toUsageWindow = ({
  usedPercent,
  windowSeconds,
  resetAt,
  valueLabel,
  suffix,
  detail,
  extra,
  warn,
  sectionHeader,
  trendKey,
  resetText
}) => {
  const resetAfterSeconds = calculateResetAfterSeconds(resetAt);
  const resetFormatted = hasResetTimestamp(resetAt) ? formatResetTime(resetAt) : null;
  const hasFiniteUsedPercent = typeof usedPercent === 'number' && Number.isFinite(usedPercent);
  return {
    usedPercent,
    remainingPercent: hasFiniteUsedPercent ? Math.max(0, 100 - usedPercent) : null,
    windowSeconds: windowSeconds ?? null,
    resetAfterSeconds,
    resetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
    ...(valueLabel ? { valueLabel } : {}),
    ...(suffix ? { suffix } : {}),
    ...(Array.isArray(detail) && detail.length ? { detail } : {}),
    ...(Array.isArray(extra) && extra.length ? { extra } : {}),
    ...(warn ? { warn } : {}),
    ...(sectionHeader ? { sectionHeader } : {}),
    ...(trendKey ? { trendKey } : {}),
    ...(resetText ? { resetText } : {})
  };
};

export const buildResult = ({ providerId, providerName, ok, configured, usage, error, accountKey }) => ({
  providerId,
  providerName,
  ok,
  configured,
  usage: usage ?? null,
  ...(error ? { error } : {}),
  fetchedAt: Date.now(),
  ...(accountKey ? { accountKey } : {})
});

export const durationToLabel = (duration, unit) => {
  if (!duration || !unit) return 'limit';
  if (unit === 'TIME_UNIT_MINUTE') return `${duration}m`;
  if (unit === 'TIME_UNIT_HOUR') return `${duration}h`;
  if (unit === 'TIME_UNIT_DAY') return `${duration}d`;
  return 'limit';
};

export const durationToSeconds = (duration, unit) => {
  if (!duration || !unit) return null;
  if (unit === 'TIME_UNIT_MINUTE') return duration * 60;
  if (unit === 'TIME_UNIT_HOUR') return duration * 3600;
  if (unit === 'TIME_UNIT_DAY') return duration * 86400;
  return null;
};

export const formatMoney = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};
