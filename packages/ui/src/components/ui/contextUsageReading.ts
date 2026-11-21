import type { SessionContextUsage } from '@/stores/types/sessionTypes';

export type ContextUsageReading =
  | { state: 'measured'; totalTokens: number; percentage: number; colorPercentage?: number }
  | { state: 'compacted' };

export const toContextUsageReading = (usage: SessionContextUsage): ContextUsageReading => {
  if (usage.state === 'compacted') return { state: 'compacted' };
  return {
    state: 'measured',
    totalTokens: usage.totalTokens,
    percentage: usage.contextLimit > 0 ? Math.min(999, (usage.totalTokens / usage.contextLimit) * 100) : 0,
    colorPercentage: usage.percentage,
  };
};
