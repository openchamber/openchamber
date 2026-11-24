export type SessionCostLevel = 'warn' | 'critical';

export type SessionCostThresholds = { warn: number; critical: number };

export const SESSION_COST_LEVEL_COLOR = {
  warn: 'var(--status-warning)',
  critical: 'var(--status-error)',
} satisfies Record<SessionCostLevel, string>;

export const sessionCostLevel = (cost: number, thresholds: SessionCostThresholds): SessionCostLevel | null => {
  if (cost >= thresholds.critical) return 'critical';
  if (cost >= thresholds.warn) return 'warn';
  return null;
};

export const sessionCostLevelRank = (level: SessionCostLevel | null | undefined): number => (
  level === 'critical' ? 2 : level === 'warn' ? 1 : 0
);
