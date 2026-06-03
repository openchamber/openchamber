import type { Theme } from '@/types/theme';

export const withThemeDefaults = (theme: Theme): Theme => {
  const chat = theme.colors.chat ?? {};
  const markdown = theme.colors.markdown ?? {};
  const surface = theme.colors.surface;
  const primary = theme.colors.primary;
  const interactive = theme.colors.interactive;

  return {
    ...theme,
    colors: {
      ...theme.colors,
      chat: {
        background: surface.background,
        avatarBackground: surface.background,
        avatarForeground: surface.foreground,
        slashCommandBackground: primary.base,
        slashCommandForeground: primary.foreground ?? surface.foreground,
        inputWorkingBorderColor1: primary.base,
        inputWorkingBorderColor2: primary.hover ?? primary.base,
        inputWorkingBorderColor3: primary.muted ?? primary.base,
        typing: surface.mutedForeground,
        ...chat,
      },
      markdown: {
        inlineCodeBorder: interactive.border,
        blockquoteBackground: 'transparent',
        ...markdown,
      },
    },
  };
};
