import { expect, it } from 'vitest';
import { diagnosticErrorMessage } from './vocabulary.js';

it('retains unchecked error-message coercion and its failures', () => {
  let lengths = 0;
  let coercions = 0;
  const message = {
    get length() {
      lengths += 1;
      return '12';
    },
    toString() {
      coercions += 1;
      return coercions === 1 ? 'other' : 'getaddrinfo ENOTFOUND example.com';
    },
  };
  expect(diagnosticErrorMessage(message)).toBe('getaddrinfo ENOTFOUND [host]');
  expect(lengths).toBe(1);
  expect(coercions).toBe(2);
  expect(diagnosticErrorMessage(Object.assign(Object.create({ length: 257 }), {
    toString() { throw new Error('must not coerce'); },
  }))).toBeNull();
  expect(diagnosticErrorMessage(null)).toBeNull();
  expect(diagnosticErrorMessage(7)).toBeNull();
  expect(() => diagnosticErrorMessage(Symbol('message'))).toThrow(TypeError);
});
