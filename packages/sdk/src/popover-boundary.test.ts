import { expect, test } from 'bun:test';
import type { JsonValue } from './contract.ts';
import { guestPopoverRequestSchema } from './popover-schemas.ts';

const request = {
  id: 'preview-1', anchor: { x: 0, y: 20, width: 120, height: 24 },
  width: 340, height: 240,
};

test('popover data counts separators in its serialized budget', () => {
  expect(guestPopoverRequestSchema.safeParse({ ...request, data: ['a'.repeat(8000), 'b'.repeat(7993)] }).success).toBe(true);
  expect(guestPopoverRequestSchema.safeParse({ ...request, data: ['a'.repeat(8000), 'b'.repeat(7994)] }).success).toBe(false);
});

test('popover data accepts shared JSON objects and null-prototype records without coercion', () => {
  const shared = { title: 'Commit' };
  expect(guestPopoverRequestSchema.safeParse({ ...request, data: { first: shared, second: shared } }).success).toBe(true);
  const record = Object.create(null);
  record.title = 'Commit';
  expect(guestPopoverRequestSchema.safeParse({ ...request, data: record }).success).toBe(true);
});

test('popover data rejects cycles, excessive nesting and non-JSON values without throwing', () => {
  type RecursiveData = { self?: RecursiveData };
  const cyclic: RecursiveData = {};
  cyclic.self = cyclic;
  let nested: JsonValue = null;
  for (let index = 0; index < 10000; index++) nested = [nested];
  for (const value of [cyclic, nested, Number.NaN, undefined, { value: Infinity }, new Date()]) {
    expect(guestPopoverRequestSchema.safeParse({ ...request, data: value }).success).toBe(false);
  }
});

test('prototype-named properties and array extras cannot bypass the payload budget', () => {
  const data = JSON.parse('{"__proto__":null}');
  data.__proto__ = 'x'.repeat(16001);
  expect(guestPopoverRequestSchema.safeParse({ ...request, data }).success).toBe(false);
  const array = Object.assign([null], { extra: 'x'.repeat(16001) });
  expect(guestPopoverRequestSchema.safeParse({ ...request, data: array }).success).toBe(false);
  expect(guestPopoverRequestSchema.safeParse({ ...request, data: JSON.parse('{"__proto__":{"title":"safe"}}') }).success).toBe(true);
});
