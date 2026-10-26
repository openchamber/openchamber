import type { Theme } from '@/types/theme';
import { resolveSyntaxTokens } from '@/lib/theme/syntax';

/**
 * Build the `--md-syntax-*` CSS custom properties for the given app theme.
 * Apply the result as inline styles on the markdown container so the static
 * Shiki theme resolves to the active palette.
 *
 * Keep this helper independent of highlighter registration so eager code
 * consumers can resolve colors without loading a renderer or diff stack.
 */
export const getMarkdownSyntaxVars = (theme: Theme): Record<string, string> => {
  const base = theme.colors.syntax.base;
  const tokens = resolveSyntaxTokens(theme.colors.syntax);
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
    '--md-syntax-inserted': theme.colors.syntax.highlights?.diffAdded ?? status.success,
    '--md-syntax-deleted': theme.colors.syntax.highlights?.diffRemoved ?? status.error,
    ...Object.fromEntries(Object.entries(tokens).map(([key, value]) => [`--md-token-${key}`, value])),
  };
};
