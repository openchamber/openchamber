/**
 * Reading the free-form values the runtime records.
 *
 * A tool call's arguments and metadata are whatever the model and the tool
 * produced: an object whose fields can be anything. The export reads a few
 * of them — a path, a command, a description — and it has to know whether a
 * field really holds the text it looks like.
 *
 * This module is the boundary: a value is read once, and what comes back is
 * a domain value or nothing. A field that does not hold text is treated as
 * absent, because a malformed field must not blank the whole call.
 */

import { z } from 'zod';
import type { JsonValue } from '@/lib/opencode/model';

/** A JSON value, as the runtime records it. */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

/** An object of JSON values, as a call's arguments and metadata are. */
const jsonRecordSchema: z.ZodType<Record<string, JsonValue>> = z.record(z.string(), jsonValueSchema);

/**
 * A text field, trimmed, when the field holds text at all.
 *
 * The schema ends in `catch` because a field that holds no text is an absent
 * field, not a broken one: the export reads a handful of fields of every
 * tool call, and most of the fields it probes are not there at all. A parse
 * that fails would build an error object for every one of them, and nobody
 * reads it.
 */
const textFieldSchema = z.string().trim().min(1).optional().catch(undefined);

/**
 * The text of a field, when the field holds text.
 *
 * A field that holds something else — a number, an object, nothing — is
 * absent, not a broken value.
 */
export const readTextField = (value: JsonValue | undefined): string | undefined => {
  const parsed = textFieldSchema.safeParse(value);
  return parsed.data;
};

/**
 * The fields of a call's arguments and metadata that the export reads.
 *
 * The record is parsed once, and a malformed field leaves the rest alone.
 */
export const readJsonRecord = (value: JsonValue | undefined): Record<string, JsonValue> => {
  const parsed = jsonRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
};

/**
 * A timestamp, when the value is a usable one.
 *
 * A timestamp is a number of milliseconds since the epoch. A missing one
 * leaves the event without a time, and the export says so once at the end.
 */
export const readTimestamp = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
};
