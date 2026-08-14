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

// Superseded by the per-runtime key. Removed once the scoped key is written so
// theme persistence has a single owner; the pre-React HTML shells that read
// them (splash theme class and colors) have their own fallbacks.
const LEGACY_THEME_KEYS = [
  'themeMode',
  'lightThemeId',
  'darkThemeId',
  'useSystemTheme',
  'selectedThemeId',
  'selectedThemeVariant',
  'splashBgLight',
  'splashFgLight',
  'splashBgDark',
  'splashFgDark',
] as const;

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
    return;
  }
  // One-time migration: keep the legacy keys only if the scoped write failed,
  // otherwise remove them (removal is best-effort; a stale key only affects
  // the pre-React splash, which falls back to system preference and defaults).
  for (const key of LEGACY_THEME_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore — best-effort cleanup
    }
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
