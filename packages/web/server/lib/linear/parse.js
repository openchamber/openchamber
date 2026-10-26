import { isString } from '../shared/guards.js';

export { isString, isPlainObject } from '../shared/guards.js';

export function readTrimmedString(value) {
  return isString(value) && value.trim() ? value.trim() : '';
}

export function readFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

export function readEnv(name) {
  const raw = process.env[name];
  return raw ? raw.trim() : '';
}
