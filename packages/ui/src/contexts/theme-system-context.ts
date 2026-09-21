import { createContext } from 'react';

import type { Theme, ThemeMode } from '@/types/theme';
import type { ThemeDefinition } from '@/lib/theme/definition';

export interface ThemeContextValue {
  currentTheme: Theme;
  availableThemes: Theme[];
  customThemeIds: string[];
  setTheme: (themeId: string) => void;
  customThemesLoading: boolean;
  reloadCustomThemes: () => Promise<void>;
  importTheme: (definition: ThemeDefinition, options?: { activate?: boolean }) => Promise<Theme>;
  deleteImportedTheme: (themeId: string) => Promise<void>;
  isSystemPreference: boolean;
  setSystemPreference: (use: boolean) => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  lightThemeId: string;
  darkThemeId: string;
  setLightThemePreference: (themeId: string) => void;
  setDarkThemePreference: (themeId: string) => void;
}

export const ThemeSystemContext = createContext<ThemeContextValue | undefined>(undefined);
