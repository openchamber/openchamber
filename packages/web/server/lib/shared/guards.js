
export const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

export { isPlainObject, isBoolean, isRecord } from './object-guards.js';

export const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};
