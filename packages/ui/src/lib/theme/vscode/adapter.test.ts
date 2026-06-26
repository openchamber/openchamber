import { describe, expect, test } from 'bun:test';

import { buildVSCodeThemeFromPalette, type VSCodeThemePalette } from './adapter';

const buildPalette = (colors: Partial<VSCodeThemePalette['colors']>): VSCodeThemePalette => ({
  kind: 'dark',
  colors,
});

const isOpaqueHex = (color: string): boolean =>
  !color.startsWith('#') || color.length <= 7;

describe('buildVSCodeThemeFromPalette surface opacity', () => {
  test('flattens alpha on muted so tooltip/popover backgrounds are opaque', () => {
    // VS Code overlay tokens are frequently translucent (e.g. #RRGGBBAA).
    const palette = buildPalette({
      'chat.requestBackground': '#1e1e1e66',
      'list.inactiveSelectionBackground': '#37373d99',
      'editor.lineHighlightBackground': '#00000033',
    });

    const theme = buildVSCodeThemeFromPalette(palette);
    const muted = theme.colors.surface.muted;

    expect(isOpaqueHex(muted)).toBe(true);
    expect(muted.includes('rgba')).toBe(false);
  });

  test('flattens rgba() alpha on muted into an opaque rgb()', () => {
    const palette = buildPalette({
      'editor.lineHighlightBackground': 'rgba(0, 0, 0, 0.2)',
    });

    const theme = buildVSCodeThemeFromPalette(palette);

    expect(theme.colors.surface.muted).toBe('rgb(0, 0, 0)');
  });

  test('flattens alpha on elevated, background, and subtle surface fills', () => {
    const palette = buildPalette({
      'chat.list.background': '#1e1e1e55',
      'editorWidget.background': '#252526aa',
      'input.background': '#31313380',
    });

    const theme = buildVSCodeThemeFromPalette(palette);
    const { background, elevated, subtle } = theme.colors.surface;

    for (const color of [background, elevated, subtle]) {
      expect(isOpaqueHex(color)).toBe(true);
      expect(color.includes('rgba')).toBe(false);
    }
  });

  test('leaves already-opaque surface colors untouched', () => {
    const palette = buildPalette({
      'chat.list.background': '#1e1e1e',
      'editorWidget.background': '#252526',
      'list.inactiveSelectionBackground': '#37373d',
    });

    const theme = buildVSCodeThemeFromPalette(palette);

    expect(theme.colors.surface.background).toBe('#1e1e1e');
    expect(theme.colors.surface.elevated).toBe('#252526');
    expect(theme.colors.surface.muted).toBe('#37373d');
  });
});
