
export const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

export const isPlainObject = (value) => typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

export const isBoolean = (value) => value === true || value === false;

export const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};
