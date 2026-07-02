import { registerCustomTheme, type ThemeRegistrationResolved } from '@pierre/diffs';
import type { Theme } from '@/types/theme';
import { MARKDOWN_SHIKI_THEME, MARKDOWN_SHIKI_THEME_DEFINITION } from './markdownShikiThemeDefinition';

// The static Shiki theme name. Its definition (token colors referencing
// `--md-syntax-*` CSS variables) lives in the dependency-free
// `markdownShikiThemeDefinition` module so it can also be imported inside the
// Shiki Web Worker. See that module for the rationale.


let registered = false;

/**
 * Register the static, CSS-variable-driven Shiki theme with `@pierre/diffs`.
 * Safe to call multiple times; only the first call registers.
 *
 * NOTE: markdown code highlighting now runs through the dedicated Shiki worker
 * (`markdown-worker`), which uses the raw theme definition directly. This
 * registration remains only for any `@pierre/diffs`-based consumer of the
 * `openchamber-md` theme name.
 */
export const ensureMarkdownShikiTheme = (): void => {
  if (registered) return;
  registered = true;

  registerCustomTheme(MARKDOWN_SHIKI_THEME, () =>
    Promise.resolve(MARKDOWN_SHIKI_THEME_DEFINITION as unknown as ThemeRegistrationResolved),
  );
};

/**
 * Build the `--md-syntax-*` CSS custom properties for the given app theme.
 * Apply the result as inline styles on the markdown container so the static
 * Shiki theme resolves to the active palette.
 */
export const getMarkdownSyntaxVars = (theme: Theme): Record<string, string> => {
  const base = theme.colors.syntax.base;
  const tokens = theme.colors.syntax.tokens ?? {};
  const status = theme.colors.status;

  return {
    '--md-syntax-foreground': base.foreground,
    '--md-syntax-comment': base.comment,
    '--md-syntax-string': base.string,
    '--md-syntax-number': base.number,
    '--md-syntax-keyword': base.keyword,
    '--md-syntax-operator': base.operator,
    '--md-syntax-function': base.function,
    '--md-syntax-type': base.type,
    '--md-syntax-variable': base.variable,
    '--md-syntax-property': tokens.variableProperty ?? base.variable,
    '--md-syntax-inserted': status.success,
    '--md-syntax-deleted': status.error,
  };
};
