import { describe, expect, test } from 'bun:test';
import { codeToTokens, tokenNames } from '@pierre/highlights';

import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownSyntaxVars';
import { themes } from '@/lib/theme/themes';
import { toHexColor } from '../theme/color';
import { resolveSyntaxTokens } from '../theme/syntax';
import { buildZedThemeFromAppTheme, MARKDOWN_HIGHLIGHTS_THEME } from './zedThemeFromAppTheme';

const SAMPLE = 'import { a } from "b";\n// note\nif (a) return 1;\n';

const colorOf = (tokens: { content: string; color?: string }[][], content: string) =>
  tokens.flat().find((token) => token.content.trim() === content)?.color;

describe('buildZedThemeFromAppTheme', () => {
  test('colors every built-in theme with its own syntax palette', () => {
    for (const theme of themes) {
      const zed = buildZedThemeFromAppTheme(theme);
      const base = theme.colors.syntax.base;
      const tokens = resolveSyntaxTokens(theme.colors.syntax);
      expect(zed.style['editor.foreground']).toBe(toHexColor(base.foreground) ?? undefined);
      expect(zed.style['editor.background']).toBe(toHexColor(base.background) ?? undefined);

      const { tokens: lines } = codeToTokens(SAMPLE, { lang: 'typescript', theme: zed });
      expect(colorOf(lines, '// note')).toBe(toHexColor(base.comment)?.toLowerCase());
      expect(colorOf(lines, '"b"')).toBe(toHexColor(base.string)?.toLowerCase());
      expect(colorOf(lines, 'if')).toBe(toHexColor(tokens.keywordControl)?.toLowerCase());
      expect(colorOf(lines, '1')).toBe(toHexColor(base.number)?.toLowerCase());
    }
  });

  test('styles only token names the Highlights lexers emit', () => {
    const known = new Set(tokenNames);
    const zed = buildZedThemeFromAppTheme(themes[0]);
    for (const name of Object.keys(zed.style.syntax ?? {})) expect(known.has(name)).toBe(true);
  });

  test('converts rgb() colors, which Highlights would otherwise drop', () => {
    const source = themes[0];
    const custom = {
      ...source,
      colors: { ...source.colors, syntax: { ...source.colors.syntax, base: { ...source.colors.syntax.base, comment: 'rgb(16, 32, 48)' } } },
    };
    const { tokens } = codeToTokens('// note', { lang: 'typescript', theme: buildZedThemeFromAppTheme(custom) });
    expect(colorOf(tokens, '// note')).toBe('#102030');
  });
});

describe('MARKDOWN_HIGHLIGHTS_THEME', () => {
  test('refers only to variables the markdown syntax palette defines', () => {
    const defined = new Set(Object.keys(getMarkdownSyntaxVars(themes[0])));
    const { tokens } = codeToTokens(SAMPLE, { lang: 'typescript', theme: MARKDOWN_HIGHLIGHTS_THEME });
    const referenced = new Set<string>();
    for (const [, color] of JSON.stringify(MARKDOWN_HIGHLIGHTS_THEME.style.syntax).matchAll(/"color":"([^"]+)"/g)) {
      referenced.add(`--md-${color}`);
    }
    for (const token of tokens.flat()) {
      const variable = /^var\((--md-[\w-]+)/.exec(token.color ?? '')?.[1];
      if (variable && variable !== '--md-foreground') referenced.add(variable);
    }
    expect(referenced.size).toBeGreaterThan(10);
    for (const variable of referenced) expect(defined.has(variable)).toBe(true);
  });

  test('unstyled text falls back to the syntax foreground', () => {
    const { tokens } = codeToTokens('plain', { lang: 'text', theme: MARKDOWN_HIGHLIGHTS_THEME });
    expect(tokens[0][0].color).toBe('var(--md-foreground, var(--md-syntax-foreground))');
  });
});
