import type { UsageWindow } from '@/types';

/**
 * A limit's value colour: muted while it is healthy, so the eye goes straight
 * to the limits running low, which take their state colour (warning from 50%
 * used, critical from 80%). Counts that are not limits stay muted.
 */
export const usageValueTone = (window: UsageWindow): 'muted' | 'warning' | 'error' => {
  const used = window.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return 'muted';
  if (used >= 80) return 'error';
  if (used >= 50) return 'warning';
  return 'muted';
};
