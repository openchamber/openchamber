import type { z } from 'zod';

import type { JsonValue, Metadata } from '@/lib/opencode/model';

type MetadataParseResult<T> = { success: true; data: T } | { success: false; data?: undefined };

const FAILED: MetadataParseResult<never> = { success: false };

/**
 * One parse per metadata object and schema.
 *
 * The sidebar asks every session's metadata the same questions (in work?
 * pinned? a multi-run lane? a workflow agent?) on every change of the
 * sessions list, which a running turn makes at each step. With thousands of
 * sessions that was most of the window's allocations: a failed `safeParse`
 * builds a `ZodError` with its formatted message, and a passing one copies the
 * object it checked. A metadata object is replaced, never mutated (the reducer
 * swaps in the server's record), so its answer is kept with the object and
 * dropped with it. A missing value (`undefined`, `null`) parses the same
 * every time, so its answer is kept per schema.
 *
 * The cached `data` is shared between callers: read it, never mutate it.
 */
const resultsByValue = new WeakMap<object, Map<z.ZodType, MetadataParseResult<unknown>>>();
const resultsForMissing = new WeakMap<z.ZodType, { undefined?: MetadataParseResult<unknown>; null?: MetadataParseResult<unknown> }>();

/** What callers parse: a session's metadata, or a value inside it. */
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
