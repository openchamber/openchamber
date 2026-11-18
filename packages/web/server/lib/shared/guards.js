export { isPlainObject, isBoolean, isRecord, isString } from './object-guards.js';

export const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};
