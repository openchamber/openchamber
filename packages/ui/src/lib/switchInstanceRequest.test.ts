import { describe, expect, test } from 'bun:test';

import { resolveSwitchInstanceTarget } from './switchInstanceRequest';

const keys = ['local', 'host:a', 'host:b'];

describe('resolveSwitchInstanceTarget', () => {
  test('returns -1 when there are no instances', () => {
    expect(resolveSwitchInstanceTarget([], 'local', { kind: 'direction', direction: 1 })).toBe(-1);
    expect(resolveSwitchInstanceTarget([], 'local', { kind: 'index', index: 1 })).toBe(-1);
  });

  describe('index jumps (1-based)', () => {
    test('jumps to the requested instance', () => {
      expect(resolveSwitchInstanceTarget(keys, 'local', { kind: 'index', index: 2 })).toBe(1);
      expect(resolveSwitchInstanceTarget(keys, 'local', { kind: 'index', index: 3 })).toBe(2);
    });

    test('is a no-op when the target is already active', () => {
      expect(resolveSwitchInstanceTarget(keys, 'host:a', { kind: 'index', index: 2 })).toBe(-1);
    });

    test('is a no-op when out of range', () => {
      expect(resolveSwitchInstanceTarget(keys, 'local', { kind: 'index', index: 0 })).toBe(-1);
      expect(resolveSwitchInstanceTarget(keys, 'local', { kind: 'index', index: 4 })).toBe(-1);
    });
  });

  describe('direction cycling with wrap-around', () => {
    test('cycles forward', () => {
      expect(resolveSwitchInstanceTarget(keys, 'local', { kind: 'direction', direction: 1 })).toBe(1);
      expect(resolveSwitchInstanceTarget(keys, 'host:b', { kind: 'direction', direction: 1 })).toBe(0);
    });

    test('cycles backward', () => {
      expect(resolveSwitchInstanceTarget(keys, 'host:a', { kind: 'direction', direction: -1 })).toBe(0);
      expect(resolveSwitchInstanceTarget(keys, 'local', { kind: 'direction', direction: -1 })).toBe(2);
    });

    test('is a no-op when only one instance exists', () => {
      expect(resolveSwitchInstanceTarget(['local'], 'local', { kind: 'direction', direction: 1 })).toBe(-1);
      expect(resolveSwitchInstanceTarget(['local'], 'local', { kind: 'direction', direction: -1 })).toBe(-1);
    });

    test('starts from an edge when the active key is unknown', () => {
      expect(resolveSwitchInstanceTarget(keys, 'unknown', { kind: 'direction', direction: 1 })).toBe(0);
      expect(resolveSwitchInstanceTarget(keys, 'unknown', { kind: 'direction', direction: -1 })).toBe(2);
    });
  });
});
