import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, getThemeById } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';

/** OpenChamber's default themes, which a shared page wears whatever the author's own; the reader's system picks one. */
const builtIn = (id: string): Theme => {
  const theme = getThemeById(id);
  if (!theme) throw new Error(`The built-in theme ${id} is missing`);
  return theme;
};

export const lightTheme = builtIn(DEFAULT_LIGHT_THEME_ID);
export const darkTheme = builtIn(DEFAULT_DARK_THEME_ID);
export const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
