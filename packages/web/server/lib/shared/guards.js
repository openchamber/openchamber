/**
 * Neutral value guards shared across the web server.
 *
 * These are intentionally dependency-free and feature-agnostic: they describe
 * what a value *is*, never what it means. Feature modules that need one of
 * these predicates should import it from here rather than defining a private
 * copy, so the same input can never classify differently on two surfaces.
 *
 * Only the dominant spelling of each guard lives here. Variants that look
 * similar but answer differently for real inputs stay with their owner:
 * `terminal/runtime.js` uses `String(value) === value`, which rejects boxed
 * strings and throws on null-prototype objects; `guests/oauth.js`,
 * `opencode/settings-files.js`, and `opencode/shared.js` use a loose
 * `typeof value === 'object'` object check that classifies differently from
 * `isPlainObject`; `quota/utils/transformers.js` exports an array-accepting
 * `asObject`. See DOCUMENTATION.md for the full matrix.
 */

/**
 * True for primitive strings and `String` objects (`[object String]`).
 * This is broader than `typeof value === 'string'`; callers that only want
 * primitives must check `typeof` themselves.
 */
export const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

/**
 * True only for a plain `{}`-shaped object: not null, not an array, not a
 * boxed primitive, `Date`, `Map`, class instance, or null-prototype object.
 * Use this when the value is decoded from JSON or written back to JSON and a
 * non-plain object would be corrupted by spreading or key enumeration.
 */
export const isPlainObject = (value) => typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

/**
 * True for any non-null, non-array object: plain objects, class instances,
 * `Date`, `Map`, boxed primitives, and null-prototype objects. Use this when a
 * value only needs to be traversable as an object, not spread as JSON.
 */
export const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * Trim a string, returning `null` when the input is not a string or is empty
 * after trimming. The `null` (not `''`) answer lets callers distinguish
 * "absent" from "present".
 */
export const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};
