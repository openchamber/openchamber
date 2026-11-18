export const DEFAULT_INPUT_HISTORY_SCOPE = 'session';
export const DEFAULT_INPUT_HISTORY_LIMIT = 40;
const MIN_INPUT_HISTORY_LIMIT = 1;
const MAX_INPUT_HISTORY_LIMIT = 100;
const isInteger = (value: unknown): value is number => Number.isInteger(value);

export const isInputHistoryScope = (value: unknown): value is 'global' | 'session' => (
  value === 'global' || value === 'session'
);

export const isInputHistoryLimit = (value: unknown): value is number => (
  isInteger(value)
  && value >= MIN_INPUT_HISTORY_LIMIT
  && value <= MAX_INPUT_HISTORY_LIMIT
);
