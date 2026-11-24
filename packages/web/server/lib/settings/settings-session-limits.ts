import { z } from 'zod';
import { isBoolean } from '../shared/object-guards.js';
import type { SanitizedSettings, SettingsDocument } from './settings-helpers.js';

const positiveAmount = z.number().positive();

export const sanitizeSessionLimitSettings = (candidate: SettingsDocument, result: SanitizedSettings) => {
  if (isBoolean(candidate.sessionGoalEnabled)) {
    result.sessionGoalEnabled = candidate.sessionGoalEnabled;
  }
  if (candidate.sessionGoalChecker === 'classifier' || candidate.sessionGoalChecker === 'small-model') {
    result.sessionGoalChecker = candidate.sessionGoalChecker;
  }
  const maxAutoTurns = z.number().int().min(1).max(200).safeParse(candidate.sessionGoalMaxAutoTurns);
  if (maxAutoTurns.success) result.sessionGoalMaxAutoTurns = maxAutoTurns.data;
  if (isBoolean(candidate.sessionGoalDefaultBudgetEnabled)) {
    result.sessionGoalDefaultBudgetEnabled = candidate.sessionGoalDefaultBudgetEnabled;
  }
  const defaultBudget = positiveAmount.safeParse(candidate.sessionGoalDefaultBudget);
  if (defaultBudget.success) result.sessionGoalDefaultBudget = Math.floor(defaultBudget.data);
  if (isBoolean(candidate.sessionCostAlertsEnabled)) {
    result.sessionCostAlertsEnabled = candidate.sessionCostAlertsEnabled;
  }
  for (const key of ['sessionCostWarnThreshold', 'sessionCostCriticalThreshold'] as const) {
    const amount = positiveAmount.safeParse(candidate[key]);
    if (amount.success) result[key] = amount.data;
  }
  const { sessionCostWarnThreshold: warn, sessionCostCriticalThreshold: critical } = result;
  if (warn !== undefined && critical !== undefined && warn >= critical) {
    delete result.sessionCostWarnThreshold;
    delete result.sessionCostCriticalThreshold;
  }
};

const SESSION_COST_DEFAULTS = { sessionCostWarnThreshold: 5, sessionCostCriticalThreshold: 20 } as const;

const sessionCostAmount = (settings: SettingsDocument, key: keyof typeof SESSION_COST_DEFAULTS): number => {
  const amount = positiveAmount.safeParse(settings[key]);
  return amount.success ? amount.data : SESSION_COST_DEFAULTS[key];
};

const hasOrderedSessionCostAmounts = (settings: SettingsDocument): boolean => (
  sessionCostAmount(settings, 'sessionCostWarnThreshold') < sessionCostAmount(settings, 'sessionCostCriticalThreshold')
);

export const keepOrderedSessionCostAmounts = (current: SettingsDocument, next: SettingsDocument): void => {
  if (hasOrderedSessionCostAmounts(next)) return;
  for (const key of ['sessionCostWarnThreshold', 'sessionCostCriticalThreshold'] as const) {
    if (current[key] === undefined) delete next[key];
    else next[key] = current[key];
  }
};
