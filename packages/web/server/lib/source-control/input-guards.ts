export const isSourceControlObject = (value: unknown): value is object => typeof value === 'object'
  && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export const isSourceControlString = (value: unknown): value is string => Object.prototype.toString.call(value) === '[object String]';

export const isSourceControlInteger = (value: unknown): value is number => Number.isSafeInteger(value);

export const isSourceControlFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

export const hasSourceControlErrorCode = (value: unknown): value is { code: string | number } =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && 'code' in value
  && (typeof value.code === 'string' || typeof value.code === 'number');

export const hasSourceControlStringCode = (value: unknown): value is { code: string } =>
  hasSourceControlErrorCode(value) && typeof value.code === 'string';
