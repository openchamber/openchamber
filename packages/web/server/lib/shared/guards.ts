export { isPlainObject, isBoolean, isRecord, isString, asNonEmptyString, isPresent } from './object-guards.js';

export const hasProperties = <Value>(value: Value): value is Value & Readonly<Record<string, unknown>> => value != null;
