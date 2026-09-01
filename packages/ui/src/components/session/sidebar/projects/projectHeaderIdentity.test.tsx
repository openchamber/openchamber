import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';

import { ProjectHeaderIdentity } from './sortableItems';

const defaultTheme = getDefaultTheme(false);
const themeContext = {
  currentTheme: defaultTheme,
  availableThemes: [defaultTheme],
  setTheme: () => {},
  customThemesLoading: false,
  reloadCustomThemes: async () => {},
  isSystemPreference: false,
  setSystemPreference: () => {},
  themeMode: 'system',
  setThemeMode: () => {},
  lightThemeId: 'mock',
  darkThemeId: 'mock',
  setLightThemePreference: () => {},
  setDarkThemePreference: () => {},
} satisfies ThemeContextValue;

const renderProjectHeader = (label: string) => renderToStaticMarkup(
  <ThemeSystemContext.Provider value={themeContext}>
    <ProjectHeaderIdentity id="project-1" projectLabel={label} projectIcon="folder" />
  </ThemeSystemContext.Provider>,
);

describe('ProjectHeaderIdentity project label casing', () => {
  test('preserves a user-defined mixed-case project label', () => {
    const markup = renderProjectHeader('MyProject');

    expect(markup).toContain('>MyProject</span>');
    expect(markup).not.toContain('lowercase');
  });

  test('preserves a directory-derived project label exactly', () => {
    expect(renderProjectHeader('my-project')).toContain('>my-project</span>');
  });
});
