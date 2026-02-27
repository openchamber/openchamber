export const clampPercent = (value: number | null): number | null => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
};

export const formatPercent = (value: number | null): string => {
  const clamped = clampPercent(value);
  if (clamped === null) {
    return '-';
  }
  return `${clamped}%`;
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
  if (label === '5h') return '5-Hour';
  if (label === '7d') return '7-Day Limit';
  if (label === '7d-sonnet') return '7-Day Sonnet Limit';
  if (label === '7d-opus') return '7-Day Opus Limit';
  if (label === 'weekly') return 'Weekly Limit';
  if (label === 'daily') return 'Daily';
  if (label === 'monthly') return 'Monthly Limit';
  if (label === 'credits') return 'Credits';
  if (label === 'session') return 'Session';
  if (label === 'premium') return 'Premium Interactions';
  if (label === 'chat') return 'Chat Requests';
  if (label === 'completions') return 'Completions';
  if (label === 'premium_interactions') return 'Premium interactions';
  return label;
};

/**
 * Pace status indicating whether usage is on track, slightly fast, or too fast
 */
export type PaceStatus = 'on-track' | 'slightly-fast' | 'too-fast' | 'exhausted';

/**
 * Information about the current pace of usage
 */
export interface PaceInfo {
  /** Ratio of time elapsed in the window (0-1) */
  elapsedRatio: number;
  /** Ratio of quota used (0-1) */
  usageRatio: number;
  /** Predicted final usage percentage at end of window */
  predictedFinalPercent: number;
  /** Seconds remaining until reset */
  remainingSeconds: number;
  /** Whether usage is exhausted (100% used with time remaining) */
  isExhausted: boolean;
  /** Elapsed seconds in the window */
  elapsedSeconds: number;
  /** Total window duration in seconds */
  totalSeconds: number;
  /** Current pace status */
  status: PaceStatus;
  /** Per-unit pace rate (e.g., "2.5%/h" or "15%/d") */
  paceRateText: string;
  /** Prediction text (e.g., "85%" or "+120%") */
  predictText: string;
  /** For weekly quotas: the per-day allocation percentage */
  dailyAllocationPercent: number | null;
}

/**
 * Infer window duration in seconds from a window label.
 * Used when the API doesn't provide windowSeconds directly.
 */
export const inferWindowSeconds = (label: string): number | null => {
  const normalized = label.toLowerCase().trim();
  
  // Exact matches
  if (normalized === '5h') return 5 * 3600;
  if (normalized === '7d' || normalized === 'weekly' || normalized === '7d-sonnet' || normalized === '7d-opus') return 7 * 86400;
  if (normalized === 'monthly') return 30 * 86400;
  if (normalized === '24h' || normalized === 'daily') return 86400;
  if (normalized === '1h') return 3600;
  
  // Pattern matches
  const hourMatch = normalized.match(/^(\d+)h$/);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 3600;
  
  const dayMatch = normalized.match(/^(\d+)d$/);
  if (dayMatch) return parseInt(dayMatch[1], 10) * 86400;
  
  return null;
};

/**
 * Calculate pace information for a usage window.
 * 
 * @param usedPercent - Current usage percentage (0-100)
 * @param resetAt - Timestamp (ms) when the window resets
 * @param windowSeconds - Total window duration in seconds (can be null, will be inferred from label if possible)
 * @param windowLabel - Optional label to infer window duration from
 * @returns PaceInfo object with pace calculations
 */
export const calculatePace = (
  usedPercent: number | null,
  resetAt: number | null,
  windowSeconds: number | null,
  windowLabel?: string
): PaceInfo | null => {
  // Try to infer windowSeconds from label if not provided
  let effectiveWindowSeconds = windowSeconds;
  if (effectiveWindowSeconds === null && windowLabel) {
    effectiveWindowSeconds = inferWindowSeconds(windowLabel);
  }
  
  if (usedPercent === null || resetAt === null || effectiveWindowSeconds === null || effectiveWindowSeconds <= 0) {
    return null;
  }

  const now = Date.now();
  const remainingSeconds = Math.max(0, (resetAt - now) / 1000);
  const elapsedSeconds = Math.max(0, Math.min(effectiveWindowSeconds, effectiveWindowSeconds - remainingSeconds));
  const elapsedRatio = Math.max(0, Math.min(1, elapsedSeconds / effectiveWindowSeconds));
  const usageRatio = usedPercent / 100;
  const isExhausted = usedPercent >= 100 && remainingSeconds > 0;

  // Calculate predicted final usage
  let predictedFinalPercent: number;
  if (elapsedRatio > 0.01) {
    predictedFinalPercent = Math.min(999, (usageRatio / elapsedRatio) * 100);
  } else {
    predictedFinalPercent = usedPercent;
  }

  // Determine pace status
  let status: PaceStatus;
  if (isExhausted) {
    status = 'exhausted';
  } else if (usageRatio <= elapsedRatio) {
    status = 'on-track';
  } else if (predictedFinalPercent <= 130) {
    status = 'slightly-fast';
  } else {
    status = 'too-fast';
  }

  // Calculate pace rate text (per hour for < 5 days, per day otherwise)
  const usePerDay = effectiveWindowSeconds >= 5 * 24 * 3600;
  const unitSeconds = usePerDay ? 86400 : 3600;
  const unitSuffix = usePerDay ? 'd' : 'h';
  const totalUnits = effectiveWindowSeconds / unitSeconds;
  const elapsedUnits = Math.max(elapsedSeconds / unitSeconds, totalUnits * 0.01);
  const pacePercentPerUnit = (usedPercent / elapsedUnits);
  const paceRateText = Number.isFinite(pacePercentPerUnit)
    ? `${Math.min(999.9, Math.max(0, pacePercentPerUnit)).toFixed(1)}%/${unitSuffix}`
    : '-';

  // Calculate predict text
  const predictText = predictedFinalPercent > 100
    ? `+${Math.round(predictedFinalPercent)}%`
    : `${Math.round(predictedFinalPercent)}%`;

  // Calculate daily allocation for weekly quotas (7 days = 604800 seconds)
  // Also include monthly quotas (roughly 30 days)
  let dailyAllocationPercent: number | null = null;
  const windowDays = effectiveWindowSeconds / 86400;
  if (windowDays >= 7) {
    // For a 7-day window, each day should use ~14.3% (100/7)
    // For monthly, each day should use ~3.3% (100/30)
    dailyAllocationPercent = 100 / windowDays;
  }

  return {
    elapsedRatio,
    usageRatio,
    predictedFinalPercent,
    remainingSeconds,
    isExhausted,
    elapsedSeconds,
    totalSeconds: effectiveWindowSeconds,
    status,
    paceRateText,
    predictText,
    dailyAllocationPercent,
  };
};

/**
 * Get the color for a pace status (returns CSS variable names)
 */
export const getPaceStatusColor = (status: PaceStatus): string => {
  switch (status) {
    case 'exhausted':
    case 'too-fast':
      return 'var(--status-error)';
    case 'slightly-fast':
      return 'var(--status-warning)';
    case 'on-track':
      return 'var(--status-success)';
  }
};

/**
 * Format remaining time as a human-readable string
 */
export const formatRemainingTime = (seconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (totalHours > 0) {
    return `${totalHours}h`;
  }
  if (totalMinutes === 0) {
    return '<1m';
  }
  return `${minutes}m`;
};

/**
 * Calculate the marker position for daily allocation on weekly quotas.
 * Returns a percentage (0-100) representing where the "expected" usage should be
 * based on how much time has elapsed.
 * 
 * @param elapsedRatio - Ratio of time elapsed (0-1)
 * @returns Expected usage percentage based on time elapsed
 */
export const calculateExpectedUsagePercent = (elapsedRatio: number): number => {
  return Math.min(100, Math.max(0, elapsedRatio * 100));
};
