import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { parseMetadata } from './metadataParse';

const inWork = z.object({ openchamber: z.object({ work: z.object({ state: z.literal('open') }) }) });
const pinned = z.object({ openchamber: z.object({ pinned: z.object({ at: z.number() }) }) });

const countingSchema = <S extends z.ZodType>(schema: S) => {
  let calls = 0;
  const counted = z.custom<z.output<S>>((value) => {
    calls += 1;
    return schema.safeParse(value).success;
  });
  return { schema: counted, calls: () => calls };
};

describe('parseMetadata', () => {
  test('answers like safeParse', () => {
    const metadata = { openchamber: { work: { state: 'open' }, pinned: { at: 1 } } };
    expect(parseMetadata(inWork, metadata)).toEqual({ success: true, data: { openchamber: { work: { state: 'open' } } } });
    expect(parseMetadata(inWork, { openchamber: { work: { state: 'done' } } }).success).toBe(false);
    expect(parseMetadata(pinned, metadata).data?.openchamber.pinned.at).toBe(1);
    expect(parseMetadata(inWork, undefined).success).toBe(false);
    expect(parseMetadata(inWork, null).success).toBe(false);
    expect(parseMetadata(z.string(), 'text')).toEqual({ success: true, data: 'text' });
  });

  test('parses one metadata object once per schema', () => {
    const counted = countingSchema(inWork);
    const other = countingSchema(pinned);
    const metadata = { openchamber: { work: { state: 'open' } } };
    for (let index = 0; index < 5; index += 1) {
      parseMetadata(counted.schema, metadata);
      parseMetadata(other.schema, metadata);
    }
    expect(counted.calls()).toBe(1);
    expect(other.calls()).toBe(1);
  });

  test('a replaced metadata object is parsed again', () => {
    const counted = countingSchema(inWork);
    expect(parseMetadata(counted.schema, { openchamber: { work: { state: 'open' } } }).success).toBe(true);
    expect(parseMetadata(counted.schema, { openchamber: { work: { state: 'done' } } }).success).toBe(false);
    expect(counted.calls()).toBe(2);
  });

  test('missing metadata is parsed once per schema', () => {
    const counted = countingSchema(inWork);
    for (let index = 0; index < 5; index += 1) parseMetadata(counted.schema, undefined);
    expect(counted.calls()).toBe(1);
  });
});
