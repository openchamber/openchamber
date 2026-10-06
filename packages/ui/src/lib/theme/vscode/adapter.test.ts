import { expect, test } from 'bun:test';
import { buildVSCodeThemeFromPalette, type VSCodeThemePalette } from './adapter';
import { contrastRatio, withOpacity } from '../color';

const palette: VSCodeThemePalette = {
  kind: 'dark',
  colors: {
    'editor.background': '#111111',
    'editor.foreground': '#eeeeee',
    'foreground': '#dddddd',
    'sideBar.background': '#222222',
    'panel.background': '#333333',
    'editorWidget.background': '#444444',
    'editorWidget.foreground': '#fafafa',
    'dropdown.background': '#555555',
    'dropdown.foreground': '#bbbbbb',
    'input.background': '#666666',
    'input.foreground': '#ffffff',
    'descriptionForeground': '#999999',
    'chat.requestBackground': '#777777',
    'chat.requestBorder': '#101010',
    'widget.border': '#888888',
    'list.inactiveSelectionBackground': '#990000',
    'list.activeSelectionBackground': '#004400',
    'list.activeSelectionForeground': '#ccffcc',
    'editor.selectionBackground': '#000044',
    'editor.selectionForeground': '#ccccff',
    'inputOption.activeForeground': '#ff00ff',
    'toolbar.hoverBackground': '#454545',
    'button.background': '#ffaa00',
    'focusBorder': '#00ffff',
  },
};

test('high contrast retains authored canvas, secondary layout, elevated controls and code roles', () => {
  const { colors } = buildVSCodeThemeFromPalette({ ...palette, highContrast: true });
  expect(colors.surface.background).toBe('#111111');
  expect(colors.surface.muted).toBe('#222222');
  expect(colors.surface.elevated).toBe('#444444');
  expect(colors.surface.elevatedForeground).toBe('#fafafa');
  expect(colors.surface.subtle).toBe('#222222');
  expect(colors.surface.mutedForeground).toBe('#999999');
  expect(colors.syntax.base.background).toBe('#111111');
  expect(colors.syntax.base.foreground).toBe('#eeeeee');
  expect(colors.markdown?.inlineCodeBackground).toBe('#111111');
  expect(colors.chat?.userMessageBackground).toBe('#777777');
  expect(colors.interactive.border).toBe('#888888');
});

test('keeps the list selection pair together and separates selection, press and focus', () => {
  const { colors } = buildVSCodeThemeFromPalette(palette);
  expect(colors.interactive.selection).toBe('#004400');
  expect(colors.interactive.selectionForeground).toBe('#ccffcc');
  expect(contrastRatio(colors.interactive.hover, colors.surface.background)).toBeLessThanOrEqual(1.18);
  expect(contrastRatio(colors.interactive.active, colors.surface.background)).toBeLessThanOrEqual(1.25);
  expect(colors.interactive.borderFocus).toBe('#00ffff');
  expect(colors.primary.base).toBe('#ffaa00');
});

test('uses a matching dropdown or input foreground when a floating widget pair is absent', () => {
  const colors = { ...palette.colors };
  delete colors['editorWidget.background'];
  expect(buildVSCodeThemeFromPalette({ ...palette, colors, highContrast: true }).colors.surface.elevatedForeground).toBe('#bbbbbb');
  delete colors['dropdown.background'];
  const theme = buildVSCodeThemeFromPalette({ ...palette, colors, highContrast: true });
  expect(theme.colors.surface.elevated).toBe('#666666');
  expect(theme.colors.surface.elevatedForeground).toBe('#ffffff');
});

test('falls back to editor selection as a pair and gives high-contrast borders priority', () => {
  const colors = { ...palette.colors, contrastBorder: '#ffffff' };
  delete colors['list.activeSelectionBackground'];
  const theme = buildVSCodeThemeFromPalette({ kind: 'high-contrast', colors });
  expect(theme.colors.interactive.selection).toBe('#000044');
  expect(theme.colors.interactive.selectionForeground).toBe('#ccccff');
  expect(theme.colors.interactive.border).toBe('#ffffff');
  expect(theme.colors.interactive.focusRing).toBe('#00ffff');
});

test('avoids a list selection that disappears on the shared elevated surface', () => {
  const theme = buildVSCodeThemeFromPalette({ kind: 'dark', colors: {
    'editor.background': '#151313', 'editor.foreground': '#CECDC3',
    'editorWidget.background': '#282726', 'sideBar.background': '#151313',
    'list.activeSelectionBackground': '#282726', 'list.activeSelectionForeground': '#ff0000',
    'editor.selectionBackground': '#403E3C', 'editor.selectionForeground': '#CECDC3',
  } });
  expect(theme.colors.interactive.selection).toBe('#403E3C');
  expect(theme.colors.interactive.selectionForeground).toBe('#CECDC3');
});

test('does not turn borderless inputs or transparent editor diagnostics into borderless app controls and alerts', () => {
  const theme = buildVSCodeThemeFromPalette({ kind: 'dark', colors: {
    'editor.background': '#1e1e2e', 'editorWidget.background': '#181825',
    'widget.border': '#00000000', 'input.border': '#00000000', 'panel.border': '#585b70',
    'editorError.foreground': '#f38ba8', 'editorError.background': '#00000000',
    'focusBorder': '#cba6f7',
  } });
  expect(contrastRatio(theme.colors.interactive.border, theme.colors.surface.background)).toBeGreaterThan(1);
  expect(theme.colors.status.errorBackground).toBe(withOpacity(theme.colors.status.error, 0.16));
  expect(theme.colors.interactive.focusRing).toBe('#cba6f7');
});

test('preserves authored focus while softening strong borders', () => {
  const theme = buildVSCodeThemeFromPalette({ kind: 'dark', colors: {
    'editor.background': '#00151A', 'input.border': '#1B3743', 'focusBorder': '#268BD240',
  } });
  expect(contrastRatio(theme.colors.interactive.border, theme.colors.surface.background)).toBeLessThanOrEqual(1.245);
  expect(theme.colors.interactive.focusRing).toBe('#268BD240');
});
