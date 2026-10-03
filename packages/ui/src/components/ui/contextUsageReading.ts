import type { SessionContextUsage } from '@/stores/types/sessionTypes';

/** `compacted`: the session was compacted and no response has reported tokens since, so the size is unknown. */
export type ContextUsageReading =
  | { state: 'measured'; totalTokens: number; percentage: number; colorPercentage?: number }
  | { state: 'compacted' };

/**
 * The displayed percentage is unrounded so every surface agrees with the
 * work-status panel; the colour threshold keeps the store's rounded value.
 */
export const toContextUsageReading = (usage: SessionContextUsage): ContextUsageReading => {
  if (usage.state === 'compacted') return { state: 'compacted' };
  return {
    state: 'measured',
    totalTokens: usage.totalTokens,
    percentage: usage.contextLimit > 0 ? Math.min(999, (usage.totalTokens / usage.contextLimit) * 100) : 0,
    colorPercentage: usage.percentage,
  };
};
