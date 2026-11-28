import { describe, expect, test } from 'bun:test';
import { themes } from './themes';
import { editorTheme, changeThemeColor, changeBackgroundOpacity, parseEditorTheme, colorOpacity } from './editor';
import { requireTheme, compactTheme } from './definition';
import { windowSurfaceColors } from './transparency';

describe('theme editing', () => {
  test('edits and exports a new background-alpha palette without modifying its source', () => {
    const source = themes[0];
    const original = JSON.stringify(source);
    let draft = editorTheme(source);
    draft = changeThemeColor(draft, 'surface.background', '#123456');
    draft = changeBackgroundOpacity(draft, 'surface.background', 0.4);
    draft = { ...draft, config: { ...draft.config, backgroundOpacity: 0.5, fonts: { mono: '"Example Mono", monospace' } } };
    const loaded = parseEditorTheme(JSON.stringify(compactTheme(draft)));
    expect(loaded.colors.surface.background).toBe('#12345666');
    expect(loaded.config).toEqual(draft.config);
    expect(windowSurfaceColors(loaded, 0.5).background).toBe('#12345633');
    expect(JSON.stringify(source)).toBe(original);
  });
  test('keeps foregrounds opaque on import and on color changes and forbids their alpha controls', () => {
    const source = themes[0];
    const theme = requireTheme({ ...source, colors: { ...source.colors,
      surface: { ...source.colors.surface, foreground: '#abcdef22' },
      markdown: { italic: 'rgba(12, 34, 56, 0.1)' },
    } });
    expect(theme.colors.surface.foreground).toBe('#abcdef');
    expect(theme.colors.markdown?.italic).toBe('#0c2238');
    const draft = changeThemeColor(editorTheme(theme), 'surface.foreground', '#abcdef33');
    expect(draft.colors.surface.foreground).toBe('#abcdef');
    expect(() => changeBackgroundOpacity(draft, 'surface.foreground', 0.4)).toThrow();
    expect(() => changeBackgroundOpacity(draft, 'syntax.base.keyword', 0.4)).toThrow();
    expect(() => changeBackgroundOpacity(draft, 'surface.background', NaN)).toThrow();
  });
  test('retains existing alpha borders and resolves omitted editable component roles', () => {
    const source = themes.find((theme) => theme.metadata.id === 'catppuccin-dark')!;
    const draft = editorTheme(source);
    expect(draft.colors.interactive.border).toBe(source.colors.interactive.border.toLowerCase());
    expect(draft.colors.markdown?.bold).toBe(source.colors.surface.foreground.toLowerCase());
    expect(colorOpacity(draft.colors.surface.foreground)).toBe(1);
    const recolored = changeThemeColor(draft, 'interactive.border', '#abcdef');
    expect(colorOpacity(recolored.colors.interactive.border)).toBe(colorOpacity(draft.colors.interactive.border));
    expect(() => parseEditorTheme('{broken')).toThrow();
    expect(() => parseEditorTheme(' '.repeat(512 * 1024 + 1))).toThrow();
  });
  test('re-derives inherited component colors while preserving explicit overrides', () => {
    const source = editorTheme(themes[0]);
    const theme = changeThemeColor(source, 'surface.foreground', '#abcdef');
    expect(theme.colors.markdown?.bold).toBe('#abcdef');
    const overridden = changeThemeColor(source, 'markdown.bold', '#123456');
    expect(changeThemeColor(overridden, 'surface.foreground', '#abcdef').colors.markdown?.bold).toBe('#123456');
    const canvas = changeThemeColor(source, 'surface.background', '#234567');
    expect(canvas.colors.chat?.background).toBe('#234567');
  });
  test('keeps color editing available while the draft name is incomplete', () => {
    for (const name of ['', '  ']) {
      const source = editorTheme(themes[0]);
      const draft = { ...source, metadata: { ...source.metadata, name } };
      const recolored = changeThemeColor(draft, 'surface.background', '#123456');
      const translucent = changeBackgroundOpacity(recolored, 'surface.background', 0.4);
      expect(translucent.metadata.name).toBe(name);
      expect(translucent.colors.surface.background).toBe('#12345666');
      expect(translucent.colors.chat?.background).toBe('#12345666');
      expect(draft.colors).toEqual(source.colors);
      expect(() => compactTheme(translucent)).toThrow();
      expect(() => requireTheme(translucent)).toThrow();
      expect(compactTheme({ ...translucent, metadata: { ...translucent.metadata, name: 'Recovered theme' } }).metadata.name).toBe('Recovered theme');
    }
  });
  test('makes complex foreground colors opaque without nesting wrappers on repeated loads', () => {
    const source = themes[0];
    const theme = requireTheme({ ...source, colors: { ...source.colors,
      surface: { ...source.colors.surface, foreground: 'hsl(20 30% 40% / 0.2)' },
    } });
    expect(theme.colors.surface.foreground).toBe('rgb(from hsl(20 30% 40% / 0.2) r g b / 1)');
    expect(requireTheme(theme).colors.surface.foreground).toBe(theme.colors.surface.foreground);
  });
});
