import { describe, expect, it } from 'vitest';
import { isPlainObject, isString, readTrimmedString } from './parse.js';
import { isPlainObject as sharedIsPlainObject, isString as sharedIsString } from '../shared/guards.js';

describe('Linear shared parser boundary', () => {
  it('keeps the shared predicates themselves as its exports', () => {
    expect(isPlainObject).toBe(sharedIsPlainObject);
    expect(isString).toBe(sharedIsString);
  });
});
