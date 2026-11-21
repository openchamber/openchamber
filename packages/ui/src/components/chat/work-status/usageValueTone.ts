import type { UsageWindow } from '@/types';

export const usageValueTone = (window: UsageWindow): 'muted' | 'warning' | 'error' => {
  const used = window.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return 'muted';
  if (used >= 80) return 'error';
  if (used >= 50) return 'warning';
  return 'muted';
};
