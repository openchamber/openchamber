import { expect, test } from 'bun:test';
import { themes } from './themes';
import { getReadableThemeColors } from './readableColors';
import { contrastRatio, mixColor } from './color';
import { CSSVariableGenerator } from './cssGenerator';

test('extension text colors match app CSS and stay readable on SDK tints', () => {
  for (const theme of themes) {
    const colors = getReadableThemeColors(theme);
    const css = new CSSVariableGenerator().generate(theme);
    for (const name of ['primary', 'success', 'warning', 'error', 'info'] as const) {
      const text = colors.tinted[name];
      const base = name === 'primary' ? theme.colors.primary.base : theme.colors.status[name];
      expect(css).toContain(`--${name}-text: ${text};`);
      for (const surface of [theme.colors.surface.background, theme.colors.surface.elevated, theme.colors.surface.muted]) {
        const amounts = name === 'primary' ? [0, 0.10, 0.15, 0.16, 0.22] : name === 'error' ? [0, 0.07, 0.09, 0.10, 0.11, 0.15] : [0, 0.10, 0.15];
        for (const amount of amounts) {
          expect(contrastRatio(text, mixColor(base, surface, amount, theme.colors.surface.background), theme.colors.surface.background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    expect(css).toContain(`--interactive-selection-foreground: ${colors.selectionForeground};`);
  }
});
