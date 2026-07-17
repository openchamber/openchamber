import { describe, expect, test } from 'bun:test';
import { computeTilingCapability, type TilingCapabilityInput } from './useTilingCapability';

const baseInput: TilingCapabilityInput = {
  runtime: 'web',
  isMobile: false,
  isPWA: false,
  isVSCode: false,
  isWide: true,
  isFinePointer: true,
};

describe('computeTilingCapability', () => {
  const cases: ReadonlyArray<readonly [string, Partial<TilingCapabilityInput>, boolean]> = [
    ['web', { runtime: 'web' }, true],
    ['desktop', { runtime: 'desktop' }, true],
    ['mobile', { isMobile: true }, false],
    ['PWA', { isPWA: true }, false],
    ['VS Code', { isVSCode: true }, false],
    ['narrow viewport', { isWide: false }, false],
    ['coarse pointer', { isFinePointer: false }, false],
  ];

  for (const [name, overrides, expected] of cases) {
    test(name, () => {
      const input: TilingCapabilityInput = { ...baseInput, ...overrides };

      expect(computeTilingCapability(input)).toBe(expected);
    });
  }
});
