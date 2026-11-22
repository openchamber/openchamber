export function isPlainObject<Value extends object>(value: Value): boolean;
export function isPlainObject(value: unknown): value is Record<string, unknown>;
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export const isString = (value: unknown): value is string => typeof value === 'string';

export const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const isBoolean = (value: unknown): value is boolean => value === true || value === false;

export function isRecord<Value extends object>(value: Value): boolean;
export function isRecord(value: unknown): value is Record<string, unknown>;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export const isPresent = <Value>(value: Value): value is NonNullable<Value> => Boolean(value);

export const hasProperties = <Value>(value: Value): value is Value & Readonly<Record<string, unknown>> => value != null;

/** A field of a thrown value: a string or number as is, undefined when absent, null for any other value. */
export const errorFieldValue = (value: unknown): string | number | null | undefined => {
  if (value === undefined) return undefined;
  return typeof value === 'string' || typeof value === 'number' ? value : null;
};

/** The `code` of a thrown value (a Node system error's `ENOENT`, an app error's code), or undefined. */
export const errorCodeOf = (error: unknown): string | number | null | undefined => (error != null && typeof error === 'object' && 'code' in error ? errorFieldValue(error.code) : undefined);

export const isNumber = (value: unknown): value is number => typeof value === 'number';

export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const isFunction = (value: unknown): value is (...args: never[]) => void => typeof value === 'function';

export const isObjectLike = (value: unknown): value is object => value !== null && typeof value === 'object';

/** The `status` of a thrown value (an HTTP error's status), or undefined. */
export const errorStatusOf = (error: unknown): string | number | null | undefined => (error != null && typeof error === 'object' && 'status' in error ? errorFieldValue(error.status) : undefined);
