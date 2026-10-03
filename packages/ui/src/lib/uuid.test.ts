import { describe, expect, test } from 'bun:test';
import { generateUuid } from './uuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateUuid', () => {
  test('returns v4 UUIDs', () => {
    for (let i = 0; i < 20; i += 1) expect(UUID_V4.test(generateUuid())).toBe(true);
  });

  test('builds a v4 UUID from getRandomValues outside a secure context', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 20 }, () => generateUuid()));
      expect(ids.size).toBe(20);
      for (const id of ids) expect(UUID_V4.test(id)).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis.crypto, 'randomUUID');
      if (descriptor && !globalThis.crypto.randomUUID) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
    }
  });
});
