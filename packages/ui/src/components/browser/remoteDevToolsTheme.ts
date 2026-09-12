import { z } from 'zod';
import type { Theme } from '@/types/theme';

const colorNames = [
  'background', 'container', 'elevated', 'foreground', 'mutedForeground', 'divider',
  'selection', 'selectionForeground', 'focus', 'hover', 'active', 'primary', 'primaryForeground',
  'error', 'errorForeground', 'errorBackground', 'warning', 'warningForeground', 'warningBackground',
  'success', 'info', 'syntaxForeground', 'syntaxComment', 'syntaxKeyword', 'syntaxString',
  'syntaxNumber', 'syntaxFunction', 'syntaxVariable', 'syntaxType', 'syntaxOperator',
] as const;

const color = z.string().trim().min(1).max(64);

export const remoteDevToolsThemeMessageSchema = z.object({
  type: z.literal('openchamber-devtools-theme'),
  variant: z.enum(['light', 'dark']),
  colors: z.record(z.enum(colorNames), color),
}).strict();

export function createRemoteDevToolsThemeMessage(theme: Theme) {
  const { colors } = theme;
  const candidate = {
    type: 'openchamber-devtools-theme' as const,
    variant: theme.metadata.variant,
    colors: {
      background: colors.surface.background,
      container: colors.surface.muted,
      elevated: colors.surface.elevated,
      foreground: colors.surface.foreground,
      mutedForeground: colors.surface.mutedForeground,
      divider: colors.interactive.border,
      selection: colors.interactive.selection,
      selectionForeground: colors.interactive.selectionForeground,
      focus: colors.interactive.focusRing,
      hover: colors.interactive.hover,
      active: colors.interactive.active,
      primary: colors.primary.base,
      primaryForeground: colors.primary.foreground ?? colors.surface.background,
      error: colors.status.error,
      errorForeground: colors.status.errorForeground,
      errorBackground: colors.status.errorBackground,
      warning: colors.status.warning,
      warningForeground: colors.status.warningForeground,
      warningBackground: colors.status.warningBackground,
      success: colors.status.success,
      info: colors.status.info,
      syntaxForeground: colors.syntax.base.foreground,
      syntaxComment: colors.syntax.base.comment,
      syntaxKeyword: colors.syntax.base.keyword,
      syntaxString: colors.syntax.base.string,
      syntaxNumber: colors.syntax.base.number,
      syntaxFunction: colors.syntax.base.function,
      syntaxVariable: colors.syntax.base.variable,
      syntaxType: colors.syntax.base.type,
      syntaxOperator: colors.syntax.base.operator,
    },
  };
  const parsed = remoteDevToolsThemeMessageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
