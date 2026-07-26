import { describe, expect, test } from 'bun:test';

import { themes } from '@/lib/theme/themes';
import { getResolvedShikiTheme, getThemeContentSignature } from './appThemeRegistry';

describe('appThemeRegistry', () => {
  test('invalidates resolved themes when content changes under the same ID', () => {
    const original = themes[0];
    const changed = {
      ...original,
      colors: {
        ...original.colors,
        syntax: {
          ...original.colors.syntax,
          base: {
            ...original.colors.syntax.base,
            keyword: original.colors.syntax.base.string,
          },
        },
      },
    };

    expect(getThemeContentSignature(changed)).not.toBe(getThemeContentSignature(original));
    expect(getResolvedShikiTheme(changed)).not.toBe(getResolvedShikiTheme(original));
  });

  test('reuses resolved themes for identical content', () => {
    const original = themes[0];
    const clone = JSON.parse(JSON.stringify(original));

    expect(getResolvedShikiTheme(clone)).toBe(getResolvedShikiTheme(original));
  });
});
