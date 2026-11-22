import { describe, expect, it } from 'vitest';

import {
  asNonEmptyString,
  isBoolean,
  isPlainObject,
  isRecord,
  isString,
} from './guards.js';
import { errorCodeOf, errorStatusOf } from './object-guards.js';

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
  it('accepts primitive strings, including the empty string', () => {
    expect(isString('s')).toBe(true);
    expect(isString('')).toBe(true);
    expect(isString('   ')).toBe(true);
  });

  it('rejects objects that only claim to be strings', () => {
    expect(isString(boxedString)).toBe(false);
    expect(isString({ [Symbol.toStringTag]: 'String' })).toBe(false);
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

describe('isBoolean', () => {
  it('accepts only the primitive booleans', () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean(false)).toBe(true);
  });

  it('rejects the string form and every non-boolean value', () => {
    for (const value of ['true', 'false', 1, 0, '', 's', null, undefined, {}, [], NaN, Object(true)]) {
      expect(isBoolean(value), `isBoolean(${label(value)})`).toBe(false);
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

// The oracle is the contract in object-guards.ts: a string or number field is
// returned as is, an absent field (or a non-object throw) is undefined, and
// any other field value is null.
describe('errorCodeOf and errorStatusOf', () => {
  const cases = [
    [Object.assign(new Error('x'), { code: 'ENOENT', status: 404 }), 'ENOENT', 404],
    [{ code: 7, status: '503' }, 7, '503'],
    [{ code: { nested: true }, status: true }, null, null],
    [{ code: undefined }, undefined, undefined],
    [{}, undefined, undefined],
    [new Error('plain'), undefined, undefined],
    ['ENOENT', undefined, undefined],
    [null, undefined, undefined],
    [undefined, undefined, undefined],
  ];
  it.each(cases)('reads %o', (error, code, status) => {
    expect(errorCodeOf(error)).toBe(code);
    expect(errorStatusOf(error)).toBe(status);
  });
});
