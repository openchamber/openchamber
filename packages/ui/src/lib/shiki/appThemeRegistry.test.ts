import { describe, expect, test } from 'bun:test';

import { themes } from '@/lib/theme/themes';
import { getResolvedShikiTheme, getThemeContentSignature } from './appThemeRegistry';
import { CSSVariableGenerator } from '../theme/cssGenerator';
import { contrastRatio } from '../theme/color';

describe('appThemeRegistry', () => {
  test('code and diff surfaces honor the authored background without a global tint', () => {
    const generator = new CSSVariableGenerator();
    for (const theme of themes) {
      const originalBackground = theme.colors.syntax.base.background;
      const resolved = getResolvedShikiTheme(theme);
      expect(resolved.bg).toBe(originalBackground);
      expect(generator.generate(theme)).toContain(`--syntax-background: ${originalBackground};`);
      expect(resolved.colors?.['editorGutter.background']).toBe(resolved.bg);
      expect(theme.colors.syntax.base.background).toBe(originalBackground);
      expect(resolved.fg).toBe(theme.colors.syntax.base.foreground.replace(/^(#[\da-f]{6})[\da-f]{2}$/i, '$1'));
    }
    const source = themes[0];
    const custom = { ...source, colors: { ...source.colors, syntax: { ...source.colors.syntax, base: { ...source.colors.syntax.base, background: '#738291' } } } };
    expect(getResolvedShikiTheme(custom).bg).toBe('#738291');
    expect(generator.generate(custom)).toContain('--syntax-background: #738291;');
  });

  test('built-in code backgrounds remain close to their application canvas', () => {
    for (const theme of themes) {
      const contrast = contrastRatio(theme.colors.syntax.base.background, theme.colors.surface.background);
      expect(contrast).not.toBeNull();
      expect(contrast!).toBeLessThanOrEqual(1.10);
    }
  });
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
