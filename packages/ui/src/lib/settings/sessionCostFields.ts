import {
  DEFAULT_SESSION_COST_SETTINGS,
  isUsableSessionCostPair,
  readSessionCostSettings,
  writeSessionCostSettings,
  type SessionCostSettings,
} from '@/stores/useSessionCostSettingsStore';

import { parseBoolean, parsePositiveNumber, type SettingsParser } from './parsers';
import type { SettingsFieldSpec } from './registry';

const parseSessionCostAmount: SettingsParser<number> = (value, raw) => {
  const amount = parsePositiveNumber(value, raw);
  if (amount === undefined) return undefined;
  const amountOr = (key: 'sessionCostWarnThreshold' | 'sessionCostCriticalThreshold'): number => (
    parsePositiveNumber(raw[key], raw) ?? DEFAULT_SESSION_COST_SETTINGS[key]
  );
  return isUsableSessionCostPair(amountOr('sessionCostWarnThreshold'), amountOr('sessionCostCriticalThreshold')) ? amount : undefined;
};

const costField = <K extends keyof SessionCostSettings>(key: K, parse: SettingsParser<SessionCostSettings[K]>): SettingsFieldSpec<SessionCostSettings[K]> => ({
  scope: 'profile',
  parse,
  ui: {
    read: () => readSessionCostSettings()[key],
    write: (value) => {
      // SAFETY: a single-key patch built from the key it is typed by.
      writeSessionCostSettings({ [key]: value } as Pick<SessionCostSettings, K>);
    },
    autoSave: false,
  },
});

export const SESSION_COST_FIELDS = {
  sessionCostAlertsEnabled: costField('sessionCostAlertsEnabled', parseBoolean),
  sessionCostWarnThreshold: costField('sessionCostWarnThreshold', parseSessionCostAmount),
  sessionCostCriticalThreshold: costField('sessionCostCriticalThreshold', parseSessionCostAmount),
};
