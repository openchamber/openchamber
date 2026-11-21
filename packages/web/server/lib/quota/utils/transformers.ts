import { z } from 'zod';
import type { TokenWindowLimit } from './contracts.js';

export { asNonEmptyString } from '../../shared/object-guards.js';

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isString = (value: unknown): value is string => typeof value === 'string';
const isSymbol = (value: unknown): value is symbol => typeof value === 'symbol';

export const asObject = z.custom<object | null>(isObject).catch(null).parse;

export const toNumber = z.unknown().transform((value) => {
  if (isNumber(value) && Number.isFinite(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}).parse;

export const toTimestamp = z.unknown().transform((value) => {
  if (!value) return null;
  if (isNumber(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (isString(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}).parse;

export const normalizeTimestamp = z.unknown().transform((value) => {
  if (!isNumber(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}).parse;

interface TokenWindowDurations {
  readonly [unit: PropertyKey]: number | { toString(): string } | undefined;
}

const ZAI_TOKEN_WINDOW_SECONDS: TokenWindowDurations = {
  3: 60 * 60,
  6: 7 * 24 * 60 * 60
};

export const resolveWindowSeconds = (limit: TokenWindowLimit | null | undefined) => {
  if (!limit || !limit.number) return null;
  const unit = limit.unit;
  const unitSeconds = unit === undefined ? undefined : ZAI_TOKEN_WINDOW_SECONDS[isSymbol(unit) ? unit : String(unit)];
  if (!unitSeconds) return null;
  return +unitSeconds * +limit.number;
};

export const resolveWindowLabel = (windowSeconds: number | null | undefined) => {
  if (!windowSeconds) return 'tokens';
  if (windowSeconds % 86400 === 0) {
    const days = windowSeconds / 86400;
    return days === 7 ? 'weekly' : `${days}d`;
  }
  if (windowSeconds % 3600 === 0) {
    return `${windowSeconds / 3600}h`;
  }
  return `${windowSeconds}s`;
};
