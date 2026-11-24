import { create } from 'zustand';

import { getRuntimeKey } from '@/lib/runtime-switch';

export type SessionCostSettings = {
  sessionCostAlertsEnabled: boolean;
  sessionCostWarnThreshold: number;
  sessionCostCriticalThreshold: number;
};

export const DEFAULT_SESSION_COST_SETTINGS: SessionCostSettings = {
  sessionCostAlertsEnabled: false,
  sessionCostWarnThreshold: 5,
  sessionCostCriticalThreshold: 20,
};

type SessionCostSettingsState = SessionCostSettings & { runtimeKey: string | null };

export const useSessionCostSettingsStore = create<SessionCostSettingsState>()(() => ({
  ...DEFAULT_SESSION_COST_SETTINGS,
  runtimeKey: null,
}));

export const selectSessionCostSettings = (state: SessionCostSettingsState): SessionCostSettings => (
  state.runtimeKey === getRuntimeKey() ? state : DEFAULT_SESSION_COST_SETTINGS
);

export const readSessionCostSettings = (): SessionCostSettings => selectSessionCostSettings(useSessionCostSettingsStore.getState());

const isPositiveAmount = (value: number): boolean => Number.isFinite(value) && value > 0;

export const isUsableSessionCostPair = (warn: number, critical: number): boolean => (
  isPositiveAmount(warn) && isPositiveAmount(critical) && warn < critical
);

export const writeSessionCostSettings = (changes: Partial<SessionCostSettings>): void => {
  useSessionCostSettingsStore.setState((state) => ({
    ...selectSessionCostSettings(state),
    ...changes,
    runtimeKey: getRuntimeKey(),
  }));
};
