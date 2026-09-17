import { describe, expect, test } from 'bun:test';
import { compactTheme, requireTheme, themeSchema, themeListSchema } from './definition';
import { themes } from './themes';
import { CSSVariableGenerator } from './cssGenerator';
import { contrastRatio, withOpacity, mixColor } from './color';
import { getMarkdownSyntaxVars } from '../../components/chat/markdown/markdownSyntaxVars';
import { buildSyntaxTokenRules } from '../shiki/textMateThemeFromAppTheme';
import { buildVSCodeThemeFromPalette } from './vscode/adapter';

const minimal = {
  metadata: { id: 'minimal', name: 'Minimal', variant: 'dark' as const },
  colors: {
    primary: { base: '#ffcc66' },
    surface: { background: '#101010', foreground: '#eeeeee', muted: '#181818', mutedForeground: '#999999', elevated: '#202020' },
    interactive: { border: '#333333' },
    status: { error: '#ff6677', warning: '#ffcc66', success: '#88cc66', info: '#66aaff' },
    syntax: { base: { comment: '#999999', keyword: '#aa88ff', string: '#88cc66', number: '#ffcc66', function: '#66aaff', variable: '#eeeeee', type: '#66dddd', operator: '#ff6677' } },
  },
};

describe('compact theme definitions', () => {
  test('resolves a complete rendering palette from the authored roles', () => {
    const theme = requireTheme(minimal);
    expect(theme.colors.syntax.base.background).toBe('#101010');
    expect(theme.colors.syntax.tokens?.method).toBe('#66aaff');
    expect(theme.colors.syntax.tokens?.className).toBe('#66dddd');
    expect(contrastRatio(theme.colors.primary.foreground!, '#ffcc66')).toBeGreaterThanOrEqual(4.5);
    expect(theme.colors.syntax.highlights?.diffAdded).toBe('#88cc66');
    expect(new CSSVariableGenerator().generate(theme)).not.toContain('undefined');
  });

  test('retains explicit syntax exceptions in chat and file highlighting', () => {
    const theme = requireTheme({ ...minimal, colors: { ...minimal.colors, syntax: { ...minimal.colors.syntax, tokens: { className: '#abcdef', variableProperty: '#fedcba' } } } });
    expect(theme.colors.syntax.tokens?.struct).toBe('#abcdef');
    expect(theme.colors.syntax.tokens?.key).toBe('#fedcba');
    expect(getMarkdownSyntaxVars(theme)['--md-token-className']).toBe('#abcdef');
    expect(buildSyntaxTokenRules(theme.colors.syntax).find((rule) => rule.name === 'classes')?.settings.foreground).toBe('#abcdef');
  });

  test('preserves all built-in resolved colors across compact JSON round trips', () => {
    for (const theme of themes) {
      const compact = compactTheme(theme);
      const comparable = (value: typeof theme) => JSON.parse(JSON.stringify(value).toLowerCase());
      expect(comparable(requireTheme(JSON.parse(JSON.stringify(compact))))).toEqual(comparable(requireTheme(theme)));
      expect(compactTheme(requireTheme(compact))).toEqual(compact);
    }
  });

  test('rejects malformed roles without dropping valid sibling themes', () => {
    const malformed = { ...minimal, colors: { ...minimal.colors, primary: { base: 42 } } };
    expect(themeSchema.safeParse(malformed).success).toBe(false);
    expect(themeListSchema.parse([malformed, minimal, null]).map((theme) => theme.metadata.id)).toEqual(['minimal']);
  });
});

describe('rendered theme color pairs', () => {
  test('keeps high-contrast VS Code fallbacks dark and its focus indicator opaque', () => {
    const theme = buildVSCodeThemeFromPalette({ kind: 'high-contrast', colors: { focusBorder: '#ffffff', 'statusBar.background': '#ff0000' } });
    expect(theme.metadata.variant).toBe('dark');
    expect(theme.colors.surface.background).toBe(themes.find((item) => item.metadata.id === 'openchamber-dark')?.colors.surface.background);
    expect(theme.colors.interactive.focusRing).toBe('#ffffff');
    expect(theme.colors.surface.overlay).not.toBe('#ff0000');
    expect(theme.colors.syntax.tokens).toEqual({});
    expect(theme.colors.syntax.highlights?.diffAddedBackground).toBe(theme.colors.tools?.edit?.addedBackground);
  });
  test('keeps tinted button labels readable across neutral surfaces and states', () => {
    const generator = new CSSVariableGenerator();
    for (const theme of themes) {
      const css = generator.generate(theme);
      const foreground = /--primary-text: ([^;]+);/.exec(css)?.[1];
      expect(foreground).toBeDefined();
      for (const background of [theme.colors.surface.background, theme.colors.surface.elevated, theme.colors.surface.muted]) {
        for (const amount of theme.metadata.variant === 'dark' ? [0.16, 0.22, 0.30] : [0.10, 0.16, 0.22]) {
          expect(contrastRatio(foreground!, mixColor(theme.colors.primary.base, background, amount, theme.colors.surface.background), theme.colors.surface.background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test('keeps error text readable on the terminal alert surface', () => {
    for (const theme of themes) {
      const css = new CSSVariableGenerator().generate(theme);
      const foreground = /--status-error-text: ([^;]+);/.exec(css)?.[1];
      expect(contrastRatio(foreground!, theme.colors.status.errorBackground, theme.colors.surface.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('replaces existing alpha rather than appending another channel', () => {
    expect(withOpacity('#ffffff22', 0.5)).toBe('#ffffff80');
    expect(withOpacity('#abc', 0.5)).toBe('#aabbcc80');
    expect(withOpacity('rgba(255, 255, 255, 0.2)', 0.5)).toBe('#ffffff80');
  });
});
