export type InputHistoryScope = 'global' | 'session';

export const DEFAULT_INPUT_HISTORY_SCOPE: InputHistoryScope = 'session';
export const DEFAULT_INPUT_HISTORY_LIMIT = 40;
export const MIN_INPUT_HISTORY_LIMIT = 1;
export const MAX_INPUT_HISTORY_LIMIT = 100;

export const isInputHistoryScope = (value: string | null | undefined): value is InputHistoryScope => (
  value === 'global' || value === 'session'
);

export const isInputHistoryLimit = (value: number | null | undefined): value is number => (
  value !== null
  && value !== undefined
  && Number.isInteger(value)
  && value >= MIN_INPUT_HISTORY_LIMIT
  && value <= MAX_INPUT_HISTORY_LIMIT
);
