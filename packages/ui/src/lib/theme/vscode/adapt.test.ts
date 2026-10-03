import { expect, test } from 'bun:test';
import { importVSCodeTheme } from './import';
import { requireTheme } from '../definition';
import { chromaticDistance, contrastRatio, rotateColorHue, withOpacity } from '../color';

test('Solarized One uses its visible highlight accent and gets a readable user bubble', () => {
  const { colors } = requireTheme(importVSCodeTheme(JSON.stringify({ name: 'Solarized One', colors: {
    'editor.background': '#1f2126', 'editor.foreground': '#839496',
    'sideBar.background': '#1f2126', 'editorWidget.background': '#1f2126',
    'button.background': '#21252B', focusBorder: '#21252B',
    'list.activeSelectionBackground': '#2C313A', 'list.highlightForeground': '#1ebcc5',
  }, semanticTokenColors: { function: '#268BD2' } }), 'solarized.json'));
  expect(colors.primary.base).toBe('#1ebcc5');
  expect(contrastRatio(colors.primary.base, colors.surface.muted)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.primary.base, colors.interactive.selection)).toBeGreaterThanOrEqual(4.5);
  expect(colors.interactive.focusRing).toBe(colors.primary.base);
  expect(colors.markdown?.link).toBe(colors.primary.base);
  const bubble = colors.chat?.userMessageBackground ?? '';
  expect(contrastRatio(bubble, colors.surface.background)).toBeGreaterThanOrEqual(1.1);
  expect(contrastRatio(colors.surface.foreground, bubble)).toBeGreaterThanOrEqual(4.5);
  expect(colors.syntax.base.function).toBe('#268BD2');
});

test('Arrakis separates active and unread colors without recoloring code or diagnostics', () => {
  const { colors } = requireTheme(importVSCodeTheme(JSON.stringify({ colors: {
    'editor.background': '#151313', 'editor.foreground': '#CECDC3',
    'sideBar.background': '#151313', 'editorWidget.background': '#282726',
    'button.background': '#5A96BC', 'editorInfo.foreground': '#5A96BC',
    'editorError.foreground': '#C15849', 'editorWarning.foreground': '#E8B04B', 'testing.iconPassed': '#7FB069',
    'list.activeSelectionBackground': '#282726', 'editor.selectionBackground': '#403E3C',
    'terminal.ansiCyan': '#de956a', 'terminal.ansiBlue': '#CC6B49', 'terminal.ansiMagenta': '#e0a98e',
    'gitDecoration.modifiedResourceForeground': '#E8B04B',
  }, semanticTokenColors: { function: '#5A96BC', type: '#e0a98e' } }), 'arrakis.json'));
  expect(chromaticDistance(colors.primary.base, colors.status.info, colors.surface.muted, colors.surface.background)).toBeGreaterThanOrEqual(0.075);
  for (const background of [colors.surface.background, colors.surface.muted, colors.interactive.selection]) {
    expect(contrastRatio(colors.primary.base, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.status.info, background)).toBeGreaterThanOrEqual(4.5);
  }
  expect(colors.status.infoBackground).toBe(withOpacity(colors.status.info, 0.16));
  expect(colors.status.infoBorder).toBe(withOpacity(colors.status.info, 0.45));
  expect(colors.status.error).toBe('#C15849');
  expect(colors.status.warning).toBe('#E8B04B');
  expect(colors.syntax.base.function).toBe('#5A96BC');
  expect(colors.syntax.highlights?.diffModified).toBe('#E8B04B');
});

test('Osaka Jade reuses a distinct authored color and keeps darker bubbles dark', () => {
  const { colors } = requireTheme(importVSCodeTheme(JSON.stringify({ colors: {
    'editor.background': '#111c18', 'editor.foreground': '#C1C497',
    'sideBar.background': '#111c18', 'editorWidget.background': '#0e1714',
    'list.activeSelectionBackground': '#16241f',
    'button.background': '#2DD5B7', 'editorInfo.foreground': '#2DD5B7',
    'editorError.foreground': '#FF5345', 'editorWarning.foreground': '#E5C736', 'testing.iconPassed': '#549e6a',
    'terminal.ansiCyan': '#2DD5B7', 'terminal.ansiBlue': '#509475', 'terminal.ansiMagenta': '#D2689C',
  } }), 'osaka.json'));
  expect(colors.primary.base).toBe('#2DD5B7');
  expect(colors.status.info).toBe('#D2689C');
  const bubble = colors.chat?.userMessageBackground ?? '';
  expect(contrastRatio(bubble, '#000000')).toBeLessThan(contrastRatio(colors.surface.background, '#000000')!);
  expect(contrastRatio(bubble, colors.surface.background)).toBeGreaterThanOrEqual(1.1);
});

test('already distinct readable accents and visible authored bubbles remain unchanged', () => {
  const { colors } = requireTheme(importVSCodeTheme(JSON.stringify({ colors: {
    'editor.background': '#1e1e2e', 'editor.foreground': '#cdd6f4',
    'button.background': '#cba6f7', 'editorInfo.foreground': '#89b4fa',
    'editorInfo.background': '#123456', 'chat.requestBubbleBackground': '#313244',
  } }), 'catppuccin.json'));
  expect(colors.primary.base).toBe('#cba6f7');
  expect(colors.status.info).toBe('#89b4fa');
  expect(colors.status.infoBackground).toBe('#123456');
  expect(colors.chat?.userMessageBackground).toBe('#313244');
});

test('neutral palettes still receive distinguishable readable info colors', () => {
  for (const [background, foreground] of [['#000000', '#ffffff'], ['#ffffff', '#000000']]) {
    const { colors } = requireTheme(importVSCodeTheme(JSON.stringify({ colors: {
      'editor.background': background, 'editor.foreground': foreground,
      'button.background': foreground, 'editorInfo.foreground': foreground,
    } }), 'neutral.json'));
    expect(chromaticDistance(colors.primary.base, colors.status.info, colors.surface.background, colors.surface.background)).toBeGreaterThanOrEqual(0.075);
    expect(contrastRatio(colors.status.info, colors.surface.background)).toBeGreaterThanOrEqual(4.5);
  }
});

test('chromatic comparisons use displayed alpha colors and hue rotation round-trips', () => {
  expect(chromaticDistance('#f000', '#00f0', '#123456', '#123456')).toBe(0);
  expect(chromaticDistance('#ffffff', '#000000', '#123456', '#123456')).toBeLessThan(0.000001);
  expect(rotateColorHue('#5a96bc', 360)).toBe('#5a96bc');
});
