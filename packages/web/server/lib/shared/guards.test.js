import { describe, expect, it } from 'vitest';

import {
  asNonEmptyString,
  isPlainObject,
  isRecord,
  isString,
} from './guards.js';

class Example {
  constructor() {
    this.value = 1;
  }
}

const nullPrototype = Object.assign(Object.create(null), { value: 1 });
const boxedString = Object('s');
const label = (value) => {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

describe('isString', () => {
  it('accepts primitive and boxed strings, including the empty string', () => {
    expect(isString('s')).toBe(true);
    expect(isString('')).toBe(true);
    expect(isString('   ')).toBe(true);
    expect(isString(boxedString)).toBe(true);
  });

  it('rejects every non-string value', () => {
    for (const value of [42, 0, NaN, true, null, undefined, [], {}, nullPrototype, new Example(), new Date(), new Map()]) {
      expect(isString(value), `isString(${label(value)})`).toBe(false);
    }
  });
});

describe('isPlainObject', () => {
  it('accepts only a plain object literal', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('rejects arrays, primitives, and absent values', () => {
    for (const value of [[], [1], 42, 0, 's', '', true, null, undefined]) {
      expect(isPlainObject(value), `isPlainObject(${label(value)})`).toBe(false);
    }
  });

  it('rejects values that merely look object-shaped', () => {
    expect(isPlainObject(boxedString)).toBe(false);
    expect(isPlainObject(new Example())).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(nullPrototype)).toBe(false);
  });
});

describe('isRecord', () => {
  it('accept every non-null, non-array object', () => {
    for (const value of [{}, { a: 1 }, boxedString, new Example(), new Date(), new Map(), nullPrototype]) {
      expect(isRecord(value), `isRecord(${label(value)})`).toBe(true);
    }
  });

  it('reject arrays, primitives, and absent values', () => {
    for (const value of [[], [1], 42, 0, NaN, 's', '', true, null, undefined]) {
      expect(isRecord(value), `isRecord(${label(value)})`).toBe(false);
    }
  });
});

describe('asNonEmptyString', () => {
  it('trims a string and returns the trimmed value', () => {
    expect(asNonEmptyString('s')).toBe('s');
    expect(asNonEmptyString('  s  ')).toBe('s');
    expect(asNonEmptyString('\n\ttab\t\n')).toBe('tab');
  });

  it('returns null for empty, whitespace-only, and non-string values', () => {
    for (const value of ['', '   ', '\n\t', 42, 0, NaN, true, null, undefined, {}, [], boxedString]) {
      expect(asNonEmptyString(value), `asNonEmptyString(${label(value)})`).toBeNull();
    }
  });
});

describe('re-exported public APIs', () => {
  it('linear/parse.js re-exports the shared predicates', async () => {
    const parse = await import('../linear/parse.js');
    expect(parse.isString).toBe(isString);
    expect(parse.isPlainObject).toBe(isPlainObject);
  });

  it('gitlab/validation.js re-exports the shared predicates', async () => {
    const validation = await import('../gitlab/validation.js');
    expect(validation.isString).toBe(isString);
    expect(validation.isPlainObject).toBe(isPlainObject);
  });

  it('opencode/config-v2.js re-exports the shared isRecord', async () => {
    const configV2 = await import('../opencode/config-v2.js');
    expect(configV2.isRecord).toBe(isRecord);
  });

  it('quota/utils/transformers.js re-exports the shared asNonEmptyString', async () => {
    const transformers = await import('../quota/utils/transformers.js');
    expect(transformers.asNonEmptyString).toBe(asNonEmptyString);
  });
});
