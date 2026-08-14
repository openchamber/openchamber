import type { ThemeMode } from '@/types/theme';

type StoredThemePreferences = {
  themeMode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
};

// Theme preferences are scoped per runtime endpoint, like the settings mirror
// (lib/persistence.ts), so windows pointing at different instances never
// overwrite or adopt each other's theme through shared localStorage.
//
// Retention is intentionally unbounded, unlike the mirror's capped 5-runtime
// index: each entry is ~150 bytes, the count is bounded by the distinct
// instances ever visited from this origin, and evicting old entries would only
// discard the last-known theme for rarely visited instances while saving
// trivial space.
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

/**
 * Resolve the preferences a cross-window storage event should apply for the
 * current runtime. Returns null — meaning "keep current preferences" — when
 * the event targets another runtime's key, when no valid stored preferences
 * exist, or when the stored preferences already match the current ones (the
 * identity check breaks cross-window adoption loops).
 */
export const resolveThemePreferencesFromStorageEvent = (
  eventKey: string | null,
  runtimeKey: string,
  current: StoredThemePreferences,
): StoredThemePreferences | null => {
  if (eventKey !== getThemePreferencesStorageKey(runtimeKey)) {
    return null;
  }
  const stored = readThemePreferencesForRuntime(runtimeKey);
  if (!stored) {
    return null;
  }
  if (stored.themeMode === current.themeMode && stored.lightThemeId === current.lightThemeId && stored.darkThemeId === current.darkThemeId) {
    return null;
  }
  return stored;
};
