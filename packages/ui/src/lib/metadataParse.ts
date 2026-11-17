import type { z } from 'zod';

import type { JsonValue, Metadata } from '@/lib/opencode/model';

type MetadataParseResult<T> = { success: true; data: T } | { success: false; data?: undefined };

const FAILED: MetadataParseResult<never> = { success: false };

const resultsByValue = new WeakMap<object, Map<z.ZodType, MetadataParseResult<unknown>>>();
const resultsForMissing = new WeakMap<z.ZodType, { undefined?: MetadataParseResult<unknown>; null?: MetadataParseResult<unknown> }>();

type MetadataValue = Metadata | JsonValue | undefined;

const parseOnce = <S extends z.ZodType>(schema: S, value: MetadataValue): MetadataParseResult<z.output<S>> => {
  const parsed = schema.safeParse(value);
  return parsed.success ? { success: true, data: parsed.data } : FAILED;
};

export const parseMetadata = <S extends z.ZodType>(schema: S, value: MetadataValue): MetadataParseResult<z.output<S>> => {
  if (value === undefined || value === null) {
    let missing = resultsForMissing.get(schema);
    if (!missing) {
      missing = {};
      resultsForMissing.set(schema, missing);
    }
    const key = value === undefined ? 'undefined' : 'null';
    const known = missing[key];
    if (known) {
      // SAFETY: entries are keyed by schema, so this one came from parsing with `schema`.
      return known as MetadataParseResult<z.output<S>>;
    }
    const result = parseOnce(schema, value);
    missing[key] = result;
    return result;
  }
  if (!(value instanceof Object)) return parseOnce(schema, value);
  let results = resultsByValue.get(value);
  if (!results) {
    results = new Map();
    resultsByValue.set(value, results);
  }
  const known = results.get(schema);
  if (known) {
    // SAFETY: entries are keyed by schema, so this one came from parsing with `schema`.
    return known as MetadataParseResult<z.output<S>>;
  }
  const result = parseOnce(schema, value);
  results.set(schema, result);
  return result;
};
