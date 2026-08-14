import type { ThemeMode } from '@/types/theme';

type StoredThemePreferences = {
  themeMode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
};

// Theme preferences are scoped per runtime endpoint, like the settings mirror
// (lib/persistence.ts), so windows pointing at different instances never
// overwrite or adopt each other's theme through shared localStorage.
const THEME_PREFERENCES_KEY_PREFIX = 'openchamber.theme.v2:';

export const getThemePreferencesStorageKey = (runtimeKey: string): string =>
  `${THEME_PREFERENCES_KEY_PREFIX}${encodeURIComponent(runtimeKey)}`;

export const readThemePreferencesForRuntime = (runtimeKey: string): StoredThemePreferences | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(getThemePreferencesStorageKey(runtimeKey));
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.themeMode !== 'light' && candidate.themeMode !== 'dark' && candidate.themeMode !== 'system') {
      return null;
    }
    if (typeof candidate.lightThemeId !== 'string' || typeof candidate.darkThemeId !== 'string') {
      return null;
    }
    const lightThemeId = candidate.lightThemeId.trim();
    const darkThemeId = candidate.darkThemeId.trim();
    if (!lightThemeId || !darkThemeId) {
      return null;
    }
    return { themeMode: candidate.themeMode, lightThemeId, darkThemeId };
  } catch {
    return null;
  }
};

export const writeThemePreferencesForRuntime = (runtimeKey: string, preferences: StoredThemePreferences): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(getThemePreferencesStorageKey(runtimeKey), JSON.stringify(preferences));
  } catch {
    // localStorage unavailable (e.g. read-only contextBridge) — the server
    // settings sync remains authoritative and the app still works.
  }
};
