import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { MobileProjectIcon } from './MobileProjectIcon';

const theme = getDefaultTheme(true);
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
  reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
  isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'dark', setThemeMode: () => {},
  lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
};

// Picking a color stores it as the icon background too, so a symbol icon's
// glyph and its stored background are the same color.
const renderXs = (iconImage: { mime: string; updatedAt: number; source: 'custom' } | null) => renderToStaticMarkup(
  <ThemeSystemContext.Provider value={themeContext}>
    <MobileProjectIcon size="xs" project={{ id: 'p1', icon: 'gamepad', color: '#f76b15', iconBackground: '#f76b15', iconImage }} />
  </ThemeSystemContext.Provider>,
);

describe('MobileProjectIcon xs', () => {
  test('draws a symbol icon without a tile in its own color', () => {
    const markup = renderXs(null);
    expect(markup).toContain('color:#f76b15');
    expect(markup).not.toContain('background-color');
  });

  test('keeps the color tile behind an image icon', () => {
    expect(renderXs({ mime: 'image/png', updatedAt: 1, source: 'custom' })).toContain('background-color:#f76b15');
  });
});
