import type { Theme } from '@/types/theme';
import { presetThemes } from './presets';
import { withPrColors } from './prColors';
import flexokiLightRaw from './flexoki-light.json';
import flexokiDarkRaw from './flexoki-dark.json';
import openchamberLightRaw from './openchamber-light.json';
import openchamberDarkRaw from './openchamber-dark.json';

export const flexokiLightTheme = withPrColors(flexokiLightRaw as Theme);
export const flexokiDarkTheme = withPrColors(flexokiDarkRaw as Theme);
export const openchamberLightTheme = withPrColors(openchamberLightRaw as Theme);
export const openchamberDarkTheme = withPrColors(openchamberDarkRaw as Theme);

export const DEFAULT_LIGHT_THEME_ID = 'openchamber-light' as const;
export const DEFAULT_DARK_THEME_ID = 'openchamber-dark' as const;

export const themes: Theme[] = [
  openchamberLightTheme,
  openchamberDarkTheme,
  flexokiLightTheme,
  flexokiDarkTheme,
  ...presetThemes.filter(
    (theme) => theme.metadata.id !== 'openchamber-light' && theme.metadata.id !== 'openchamber-dark',
  ),
];

export function getThemeById(id: string): Theme | undefined {
  // Back-compat for a short-lived rename.
  const resolvedId =
    id === 'app-light' ? 'flexoki-light' :
    id === 'app-dark' ? 'flexoki-dark' :
    id;

  return themes.find(theme => theme.metadata.id === resolvedId);
}

export function getDefaultTheme(prefersDark: boolean): Theme {
  const variant: Theme['metadata']['variant'] = prefersDark ? 'dark' : 'light';

  const defaultId = prefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  const defaultTheme = getThemeById(defaultId);
  if (defaultTheme && defaultTheme.metadata.variant === variant) {
    return defaultTheme;
  }

  return themes.find((theme) => theme.metadata.variant === variant) ?? themes[0] ?? flexokiLightTheme;
}
