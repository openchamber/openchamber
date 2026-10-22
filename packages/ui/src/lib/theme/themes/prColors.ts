import type { Theme } from '@/types/theme';

const DEFAULT_MERGED_DARK = '#8957e5';
const DEFAULT_MERGED_LIGHT = '#8250df';

const pickMergedColor = (theme: Theme): string => {
  const tokens = theme.colors.syntax?.tokens ?? {};
  const candidates = [
    tokens.className,
    tokens.enum,
    tokens.variableGlobal,
    theme.colors.syntax?.base?.keyword,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  if (candidates.length > 0) {
    return candidates[0];
  }
  return theme.metadata.variant === 'dark' ? DEFAULT_MERGED_DARK : DEFAULT_MERGED_LIGHT;
};

/** The pull request colours the stylesheet paints: the theme's own, else the colour each state stands for. */
export const resolvePrColors = (theme: Theme): NonNullable<Theme['colors']['pr']> => {
  const pr = theme.colors.pr;
  return {
    open: pr?.open || theme.colors.status.success,
    draft: pr?.draft || theme.colors.surface.mutedForeground,
    blocked: pr?.blocked || theme.colors.status.warning,
    merged: pr?.merged || (theme.metadata.variant === 'dark' ? DEFAULT_MERGED_DARK : DEFAULT_MERGED_LIGHT),
    closed: pr?.closed || theme.colors.status.error,
  };
};

export const withPrColors = (theme: Theme): Theme => {
  if (theme.colors.pr) {
    return theme;
  }

  return {
    ...theme,
    colors: {
      ...theme.colors,
      pr: {
        open: theme.colors.status.success,
        draft: theme.colors.surface.mutedForeground,
        blocked: theme.colors.status.warning,
        merged: pickMergedColor(theme),
        closed: theme.colors.status.error,
      },
    },
  };
};
