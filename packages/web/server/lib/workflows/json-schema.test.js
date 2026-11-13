import { describe, expect, it } from 'vitest';

import { findSchemaContradiction, parseJsonAnswer, validateJsonSchema } from './json-schema.js';

const schema = {
  type: 'object',
  required: ['files'],
  additionalProperties: false,
  properties: { files: { type: 'array', items: { type: 'string' } }, verdict: { enum: ['ok', 'bad'] } },
};

describe('validateJsonSchema', () => {
  it('accepts a matching value', () => {
    expect(validateJsonSchema(schema, { files: ['a.ts'], verdict: 'ok' })).toBeNull();
  });

  it.each([
    [[], 'the answer must be object'],
    [{}, 'files is required'],
    [{ files: [1] }, 'files.0 must be string'],
    [{ files: [], extra: 1 }, 'extra is not allowed'],
    [{ files: [], verdict: 'maybe' }, 'verdict must be one of "ok", "bad"'],
  ])('names the first mismatch of %j', (value, message) => {
    expect(validateJsonSchema(schema, value)).toBe(message);
  });
});

describe('findSchemaContradiction', () => {
  it('finds a required key that additionalProperties: false rules out', () => {
    expect(findSchemaContradiction({ type: 'object', required: ['x'], additionalProperties: false, properties: {} }))
      .toMatch(/x is required but/);
    expect(findSchemaContradiction(schema)).toBeNull();
  });
});

describe('parseJsonAnswer', () => {
  it('reads a bare answer, else the last fenced block', () => {
    expect(parseJsonAnswer('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseJsonAnswer('Here:\n```json\n{"a":1}\n```\nand\n```\n{"a":2}\n```')).toEqual({ value: { a: 2 } });
    expect(parseJsonAnswer('no json here')).toBeNull();
  });
});
