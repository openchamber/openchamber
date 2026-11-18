import { describe, expect, it } from 'vitest';
import { isPlainObject, isString, readTrimmedString } from './parse.js';
import { isPlainObject as sharedIsPlainObject, isString as sharedIsString } from '../shared/guards.js';

describe('Linear shared parser boundary', () => {
  it('keeps the shared predicates themselves as its exports', () => {
    expect(isPlainObject).toBe(sharedIsPlainObject);
    expect(isString).toBe(sharedIsString);
  });

  it('accepts boxed strings', () => {
    expect(readTrimmedString(Object(' value '))).toBe('value');
  });

  it('returns an unchecked trim result from a string-tagged object', () => {
    const value = { [Symbol.toStringTag]: 'String', trim: () => 17 };
    expect(isString(value)).toBe(true);
    expect(readTrimmedString(value)).toBe(17);
  });

  it('preserves the failure when a string-tagged object has no trim method', () => {
    expect(() => readTrimmedString({ [Symbol.toStringTag]: 'String' })).toThrow(TypeError);
  });
});
