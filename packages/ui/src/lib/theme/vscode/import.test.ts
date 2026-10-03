import { describe, expect, test } from 'bun:test';
import { importVSCodeTheme } from './import';
import { requireTheme, compactTheme } from '../definition';
import { MAX_THEME_IMPORT_BYTES } from '../importErrors';
import { getResolvedShikiTheme } from '../../shiki/appThemeRegistry';
import { getMarkdownSyntaxVars } from '../../../components/chat/markdown/markdownSyntaxVars';
import { contrastRatio } from '../color';

const source = {
  name: 'Fixture Night',
  type: 'dark',
  colors: {
    'editor.background': '#101820', 'editor.foreground': '#efefef',
    'sideBar.background': '#121416',
    'editorWidget.background': '#fefefe', 'editorWidget.foreground': '#222222',
    'input.background': '#333333', 'input.foreground': '#dddddd',
    'list.activeSelectionBackground': '#223366', 'list.activeSelectionForeground': '#ccddff',
    'editor.selectionBackground': '#445566', 'inputOption.activeForeground': '#ff00ff',
    'button.background': '#ffcc44', 'button.foreground': '#000000',
    'gitDecoration.addedResourceForeground': '#33dd66',
    'diffEditor.insertedLineBackground': '#33dd6620',
    'diffEditor.removedTextBackground': '#ff334420',
  },
  tokenColors: [
    { scope: 'comment', settings: { foreground: '#8899aa' } },
    { scope: ['keyword', 'storage'], settings: { foreground: '#aa66ff' } },
    { scope: 'keyword.control.import', settings: { foreground: '#cc88ff' } },
    { scope: 'source.js keyword', settings: { foreground: '#ff0000' } },
    { scope: 'string', settings: { foreground: '#99cc66' } },
    { scope: 'entity.name.function, support.function', settings: { foreground: '#44aaff' } },
    { scope: 'constant.numeric', settings: { foreground: '#ffaa55' } },
    { scope: 'variable', settings: { foreground: '#eeeeee' } },
    { scope: 'entity.name.type', settings: { foreground: '#66cccc' } },
    { scope: 'variable.other.property', settings: { foreground: '#ddaa66' } },
  ],
  semanticTokenColors: { function: '#55bbff', property: { foreground: '#eebb77' }, 'variable:typescript': '#ff0000' },
};

describe('VS Code theme import', () => {
  test('maps UI surfaces as pairs and keeps syntax and diff colors', () => {
    const definition = importVSCodeTheme(JSON.stringify(source), 'fixture.json');
    const theme = requireTheme(definition);
    expect(theme.metadata.name).toBe('Fixture Night');
    expect(theme.colors.surface.background).toBe('#101820');
    expect(theme.colors.surface.elevated).toBe('#fefefe');
    expect(theme.colors.surface.elevatedForeground).toBe('#222222');
    expect(theme.colors.surface.muted).toBe('#121416');
    expect(theme.colors.interactive.selection).toBe('#223366');
    expect(theme.colors.interactive.selectionForeground).toBe('#ccddff');
    expect(theme.colors.syntax.base.keyword).toBe('#aa66ff');
    expect(theme.colors.syntax.tokens?.keywordImport).toBe('#cc88ff');
    expect(theme.colors.syntax.base.function).toBe('#55bbff');
    expect(theme.colors.syntax.tokens?.variableProperty).toBe('#eebb77');
    expect(theme.colors.syntax.base.variable).toBe('#eeeeee');
    expect(theme.colors.syntax.highlights?.diffAdded).toBe('#33dd66');
    expect(theme.colors.syntax.highlights?.diffAddedBackground).toBe('#33dd6620');
    expect(theme.colors.syntax.highlights?.diffRemovedBackground).toBe('#ff334420');
    expect(getMarkdownSyntaxVars(theme)['--md-syntax-function']).toBe('#55bbff');
    expect(getResolvedShikiTheme(theme).tokenColors?.find((rule) => rule.name === 'functions')?.settings.foreground).toBe('#55bbff');
    expect(requireTheme(compactTheme(theme))).toEqual(theme);
  });

  test('accepts BOM, comments and trailing commas and infers light appearance', () => {
    const theme = requireTheme(importVSCodeTheme('\uFEFF{ // comment\n "colors": { "editor.background": "#fff", }, }', 'Paper.jsonc'));
    expect(theme.metadata.variant).toBe('light');
    expect(theme.metadata.name).toBe('Paper');
    expect(theme.colors.syntax.base.foreground).toBe('#000000');
    expect(theme.colors.syntax.base.keyword).toBe('#000000');
    expect(theme.colors.surface.elevated).not.toBe('#181715');
  });

  test('uses the last matching TextMate color and respects disabled semantic highlighting', () => {
    const theme = requireTheme(importVSCodeTheme(JSON.stringify({ ...source, semanticHighlighting: false, tokenColors: [...source.tokenColors, { scope: 'keyword', settings: { foreground: '#bb77ee' } }] }), 'night.json'));
    expect(theme.colors.syntax.base.keyword).toBe('#bb77ee');
    expect(theme.colors.syntax.base.function).toBe('#44aaff');
  });

  test('humanizes slug names and filename fallbacks without changing authored display names', () => {
    for (const [name, expected] of [
      ['dune-kaitain', 'Dune Kaitain'],
      ['dune_kaitain', 'Dune Kaitain'],
      ['Dune Kaitain', 'Dune Kaitain'],
      ['GitHub Dark', 'GitHub Dark'],
      ['Tokyo-Night', 'Tokyo-Night'],
      ["Dune Muad'Dib", "Dune Muad'Dib"],
      ['rose-pine 2', 'rose-pine 2'],
    ]) {
      expect(importVSCodeTheme(JSON.stringify({ ...source, name }), 'ignored.json').metadata.name).toBe(expected);
    }
    expect(importVSCodeTheme(JSON.stringify({ ...source, name: undefined }), 'dune-kaitain-color-theme.json').metadata.name).toBe('Dune Kaitain');
    expect(importVSCodeTheme(JSON.stringify({ ...source, name: undefined }), 'dune_kaitain.jsonc').metadata.name).toBe('Dune Kaitain');
  });

  test('uses general semantic wildcard defaults without copying language-specific overrides', () => {
    const theme = requireTheme(importVSCodeTheme(JSON.stringify({ ...source, semanticTokenColors: { '*': '#abcdef', function: '#fedcba', 'variable:typescript': '#ff0000' } }), 'wildcard.json'));
    expect(theme.colors.syntax.base.function).toBe('#fedcba');
    expect(theme.colors.syntax.base.variable).toBe('#abcdef');
  });

  test('does not guess missing included files or load external token files', () => {
    expect(() => importVSCodeTheme('{"include":"../base.json"}', 'child.json')).toThrow('include');
    expect(() => importVSCodeTheme('{"tokenColors":"https://example.com/tokens.json"}', 'child.json')).toThrow('include');
    expect(() => importVSCodeTheme('{"colors":{}}', 'empty.json')).toThrow('background');
  });

  test('keeps high-contrast light themes light with opaque focus and contrast borders', () => {
    const theme = requireTheme(importVSCodeTheme(JSON.stringify({ type: 'hc-light', colors: { 'editor.background': '#ffffff', 'editor.foreground': '#000000', contrastBorder: '#000000', focusBorder: '#111111' } }), 'contrast.json'));
    expect(theme.metadata.variant).toBe('light');
    expect(theme.colors.interactive.border).toBe('#000000');
    expect(theme.colors.interactive.focusRing).toBe('#111111');
  });

  test('derives readable missing text on a contrasting widget background', () => {
    const theme = requireTheme(importVSCodeTheme(JSON.stringify({ colors: { 'editor.background': '#111111', 'editor.foreground': '#eeeeee', 'editorWidget.background': '#ffffff' } }), 'mixed.json'));
    expect(contrastRatio(theme.colors.surface.elevatedForeground, theme.colors.surface.elevated)).toBeGreaterThanOrEqual(4.5);
    expect(theme.colors.syntax.base.foreground).toBe('#eeeeee');
  });

  test('normalizes faint and strong borders on every shared surface without changing focus or diff', () => {
    for (const palette of [
      { background: '#00151a', elevated: '#04181f', border: '#1b3743', target: 1.15 },
      { background: '#1f2126', elevated: '#1f2126', border: '#21252b', target: 1.15 },
      { background: '#1e1e2e', elevated: '#181825', border: '#585b70', target: 1.15 },
      { background: '#eff1f5', elevated: '#e6e9ef', border: '#acb0be', target: 1.2 },
    ]) {
      const definition = importVSCodeTheme(JSON.stringify({ colors: {
        'editor.background': palette.background, 'editorWidget.background': palette.elevated,
        'sideBar.background': palette.background, 'input.border': palette.border,
        focusBorder: '#268bd240', 'diffEditor.insertedLineBackground': '#66cc6620',
      } }), 'theme.json');
      const { colors } = requireTheme(definition);
      for (const surface of [colors.surface.background, colors.surface.muted, colors.surface.elevated]) {
        const ratio = contrastRatio(colors.interactive.border, surface, colors.surface.background)!;
        expect(ratio).toBeGreaterThanOrEqual(palette.target);
        expect(ratio).toBeLessThan(1.4);
      }
      expect(colors.interactive.focusRing).toBe('#268bd240');
      expect(colors.syntax.highlights?.diffAddedBackground).toBe('#66cc6620');
      expect(colors.tools?.border).toBe(colors.interactive.border);
      expect(colors.chat?.divider).toBe(colors.interactive.border);
    }
  });

  test('keeps authored high-contrast borders and explicitly distinct component borders', () => {
    const colors = { 'editor.background': '#111111', contrastBorder: '#ffffff', 'input.border': '#aabbcc', 'chat.requestBorder': '#ff0000', 'textBlockQuote.border': '#00ff00' };
    const highContrast = requireTheme(importVSCodeTheme(JSON.stringify({ type: 'hc-black', colors }), 'hc.json'));
    expect(highContrast.colors.interactive.border).toBe('#ffffff');
    const regular = requireTheme(importVSCodeTheme(JSON.stringify({ type: 'dark', colors }), 'normal.json'));
    expect(regular.colors.tools?.border).toBe('#ff0000');
    expect(regular.colors.markdown?.blockquoteBorder).toBe('#00ff00');
  });

  test('preserves the border when the palette mixes dark and light surfaces', () => {
    const theme = requireTheme(importVSCodeTheme(JSON.stringify({ colors: {
      'editor.background': '#111111', 'sideBar.background': '#111111',
      'editorWidget.background': '#ffffff', 'input.border': '#445566',
    } }), 'mixed.json'));
    expect(theme.colors.interactive.border).toBe('#445566');
  });

  test('rejects malformed, non-color and oversized input before saving', () => {
    expect(() => importVSCodeTheme('{', 'bad.json')).toThrow('invalid');
    expect(() => importVSCodeTheme('{"colors":{"editor.background":"red; body {display:none}"}}', 'bad.json')).toThrow('invalid');
    expect(() => importVSCodeTheme(' '.repeat(MAX_THEME_IMPORT_BYTES + 1), 'large.json')).toThrow('size');
  });
});
