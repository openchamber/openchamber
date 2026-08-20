export type InputHistoryScope = 'global' | 'session';

export const DEFAULT_INPUT_HISTORY_SCOPE: InputHistoryScope = 'global';

export const isInputHistoryScope = (value: string | null | undefined): value is InputHistoryScope => (
  value === 'global' || value === 'session'
);
