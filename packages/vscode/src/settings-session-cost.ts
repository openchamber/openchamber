import { z } from 'zod';

const SESSION_COST_KEYS = ['sessionCostWarnThreshold', 'sessionCostCriticalThreshold'] as const;
const SESSION_COST_DEFAULTS = { sessionCostWarnThreshold: 5, sessionCostCriticalThreshold: 20 };

const amount = z.number().positive().finite();
const optionalAmount = amount.optional().catch(undefined);
const sessionCostAmounts = z.object({
  sessionCostAlertsEnabled: z.boolean().optional().catch(undefined),
  sessionCostWarnThreshold: optionalAmount,
  sessionCostCriticalThreshold: optionalAmount,
});

type SessionCostSettings = z.input<typeof sessionCostAmounts>;

export const dropUnorderedSessionCostChanges = (stored: SessionCostSettings, changes: SessionCostSettings): void => {
  const requested = sessionCostAmounts.parse(changes);
  if ('sessionCostAlertsEnabled' in changes && requested.sessionCostAlertsEnabled === undefined) {
    Reflect.deleteProperty(changes, 'sessionCostAlertsEnabled');
  }
  for (const key of SESSION_COST_KEYS) {
    if (key in changes && requested[key] === undefined) Reflect.deleteProperty(changes, key);
  }
  if (requested.sessionCostWarnThreshold === undefined && requested.sessionCostCriticalThreshold === undefined) return;
  const saved = sessionCostAmounts.parse(stored);
  const warn = requested.sessionCostWarnThreshold ?? saved.sessionCostWarnThreshold ?? SESSION_COST_DEFAULTS.sessionCostWarnThreshold;
  const critical = requested.sessionCostCriticalThreshold ?? saved.sessionCostCriticalThreshold ?? SESSION_COST_DEFAULTS.sessionCostCriticalThreshold;
  if (warn < critical) return;
  for (const key of SESSION_COST_KEYS) Reflect.deleteProperty(changes, key);
};
