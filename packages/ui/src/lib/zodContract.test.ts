import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

// The app's schemas were written against the zod release where an object key
// could be absent whenever its schema accepted `undefined`. Newer releases
// reject that for `z.unknown()`, `z.undefined()` and friends, so the bump
// carries `bun-patches/zod@*.patch`, which keeps the old rule. These cases fail
// when a later bump drops the patch.
describe('zod as the app relies on it', () => {
  test('a key whose schema accepts undefined may be absent', () => {
    expect(z.object({ value: z.unknown() }).safeParse({})).toEqual({ success: true, data: {} });
    expect(z.object({ value: z.undefined() }).safeParse({}).success).toBe(true);
    expect(z.looseObject({ value: z.union([z.string(), z.undefined()]) }).safeParse({ other: 1 })).toEqual({ success: true, data: { other: 1 } });
    expect(z.object({ value: z.unknown().transform((value) => value ?? 'fallback') }).safeParse({})).toEqual({ success: true, data: { value: 'fallback' } });
  });

  test('an absent key is not invented, and a present undefined one is kept', () => {
    expect(Object.keys(z.object({ value: z.unknown() }).parse({}))).toEqual([]);
    expect(Object.keys(z.object({ value: z.unknown() }).parse({ value: undefined }))).toEqual(['value']);
  });

  test('a required key is still required', () => {
    expect(z.object({ value: z.string() }).safeParse({}).success).toBe(false);
  });

  // Each schema used to carry about a hundred method closures of its own, 11 KB
  // per schema and tens of megabytes across the app's ten thousand. The release
  // in use keeps the methods on the prototype.
  test('a schema carries its methods on the prototype', () => {
    expect(Object.getOwnPropertyNames(z.string()).length).toBeLessThan(10);
    const { parse } = z.string();
    expect(parse('still bound when detached')).toBe('still bound when detached');
  });
});
