export const DEFAULT_INPUT_HISTORY_SCOPE = 'session';
export const DEFAULT_INPUT_HISTORY_LIMIT = 40;
const MIN_INPUT_HISTORY_LIMIT = 1;
const MAX_INPUT_HISTORY_LIMIT = 100;

export const isInputHistoryScope = (value) => (
  value === 'global' || value === 'session'
);

export const isInputHistoryLimit = (value) => (
  Number.isInteger(value)
  && value >= MIN_INPUT_HISTORY_LIMIT
  && value <= MAX_INPUT_HISTORY_LIMIT
);
