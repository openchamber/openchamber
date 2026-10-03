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

describe('Catppuccin built-in palettes', () => {
  test('maps the dark variant to official Mocha roles', () => {
    const theme = themes.find((item) => item.metadata.id === 'catppuccin-dark');
    expect({
      primary: theme?.colors.primary.base,
      surface: {
        background: theme?.colors.surface.background,
        foreground: theme?.colors.surface.foreground,
        muted: theme?.colors.surface.muted,
        mutedForeground: theme?.colors.surface.mutedForeground,
        elevated: theme?.colors.surface.elevated,
      },
      status: {
        error: theme?.colors.status.error,
        warning: theme?.colors.status.warning,
        success: theme?.colors.status.success,
        info: theme?.colors.status.info,
      },
      mergedPr: theme?.colors.pr?.merged,
      inlineCodeBackground: theme?.colors.markdown?.inlineCodeBackground,
      syntax: {
        comment: theme?.colors.syntax.base.comment,
        keyword: theme?.colors.syntax.base.keyword,
        string: theme?.colors.syntax.base.string,
        number: theme?.colors.syntax.base.number,
        function: theme?.colors.syntax.base.function,
        variable: theme?.colors.syntax.base.variable,
        type: theme?.colors.syntax.base.type,
        operator: theme?.colors.syntax.base.operator,
      },
    }).toEqual({
      primary: '#cba6f7',
      surface: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        muted: '#181825',
        mutedForeground: '#a6adc8',
        elevated: '#181825',
      },
      status: {
        error: '#f38ba8',
        warning: '#fab387',
        success: '#a6e3a1',
        info: '#89b4fa',
      },
      mergedPr: '#cba6f7',
      inlineCodeBackground: '#313244',
      syntax: {
        comment: '#9399b2',
        keyword: '#cba6f7',
        string: '#a6e3a1',
        number: '#fab387',
        function: '#89b4fa',
        variable: '#cdd6f4',
        type: '#f9e2af',
        operator: '#94e2d5',
      },
    });
  });

  test('maps the light variant to official Latte roles', () => {
    const theme = themes.find((item) => item.metadata.id === 'catppuccin-light');
    expect({
      primary: theme?.colors.primary.base,
      focus: theme?.colors.interactive.focus,
      surface: {
        background: theme?.colors.surface.background,
        foreground: theme?.colors.surface.foreground,
        muted: theme?.colors.surface.muted,
        mutedForeground: theme?.colors.surface.mutedForeground,
        elevated: theme?.colors.surface.elevated,
      },
      status: {
        error: theme?.colors.status.error,
        warning: theme?.colors.status.warning,
        success: theme?.colors.status.success,
        info: theme?.colors.status.info,
      },
      mergedPr: theme?.colors.pr?.merged,
      inlineCodeBackground: theme?.colors.markdown?.inlineCodeBackground,
      syntax: {
        comment: theme?.colors.syntax.base.comment,
        keyword: theme?.colors.syntax.base.keyword,
        string: theme?.colors.syntax.base.string,
        number: theme?.colors.syntax.base.number,
        function: theme?.colors.syntax.base.function,
        variable: theme?.colors.syntax.base.variable,
        type: theme?.colors.syntax.base.type,
        operator: theme?.colors.syntax.base.operator,
      },
    }).toEqual({
      primary: '#7130c7',
      focus: '#8839ef',
      surface: {
        background: '#eff1f5',
        foreground: '#4c4f69',
        muted: '#e6e9ef',
        mutedForeground: '#5c5f77',
        elevated: '#e6e9ef',
      },
      status: {
        error: '#d20f39',
        warning: '#fe640b',
        success: '#40a02b',
        info: '#1850c1',
      },
      mergedPr: '#8839ef',
      inlineCodeBackground: '#ccd0da',
      syntax: {
        comment: '#7c7f93',
        keyword: '#8839ef',
        string: '#40a02b',
        number: '#fe640b',
        function: '#1e66f5',
        variable: '#4c4f69',
        type: '#df8e1d',
        operator: '#179299',
      },
    });
  });

  test('registers exactly one Catppuccin theme per mode', () => {
    expect(themes.filter((theme) => theme.metadata.name === 'Catppuccin').map((theme) => theme.metadata.id)).toEqual([
      'catppuccin-dark',
      'catppuccin-light',
    ]);
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
