import { isString } from '../shared/guards.js';

export { isString, isPlainObject } from '../shared/guards.js';

export function readTrimmedString(value: Parameters<typeof isString>[0]) {
  return isString(value) && value.trim() ? value.trim() : '';
}

function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

export function readFiniteNumber(value: Parameters<typeof isFiniteNumber>[0]) {
  return isFiniteNumber(value) ? value : null;
}

export function readEnv(name: string) {
  const raw = process.env[name];
  return raw ? raw.trim() : '';
}
