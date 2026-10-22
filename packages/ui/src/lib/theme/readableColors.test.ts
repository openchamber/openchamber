import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { themes } from './themes';
import { PR_PILL_TINT, getReadableThemeColors } from './readableColors';
import { resolvePrColors } from './themes/prColors';
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

test('pull request pill text stays readable on its own tint in every built-in theme', () => {
  // Positive control: the check covers every theme file, not a subset.
  const themeFiles = readdirSync(fileURLToPath(new URL('./themes', import.meta.url))).filter((file) => file.endsWith('.json'));
  expect(themes.length).toBe(themeFiles.length);
  expect(themes.length).toBeGreaterThan(50);

  const failures: string[] = [];
  for (const theme of themes) {
    const { surface } = theme.colors;
    const css = new CSSVariableGenerator().generate(theme);
    // The panel's page colour is the muted surface, or halfway to it in light
    // themes; floating, it sits on the canvas or an elevated surface.
    const pages = [surface.background, surface.elevated, surface.muted, mixColor(surface.muted, surface.background, 0.5, surface.background)];
    for (const [state, color] of Object.entries(resolvePrColors(theme))) {
      const text = new RegExp(`--pr-${state}-text: ([^;]+);`).exec(css)?.[1];
      if (!text) {
        failures.push(`${theme.metadata.id} ${state}: no --pr-${state}-text`);
        continue;
      }
      for (const page of pages) {
        const ratio = contrastRatio(text, mixColor(color, page, PR_PILL_TINT, surface.background), surface.background) ?? 0;
        if (ratio < 4.5) failures.push(`${theme.metadata.id} ${state} on ${page}: ${ratio.toFixed(2)}`);
      }
    }
  }
  expect(failures).toEqual([]);
});
