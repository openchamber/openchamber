import type { ThemeMode } from '@/types/theme';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, getThemeById } from '@/lib/theme/themes';

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

// Runtime keys that mean "no instance connected" — the uninitialized default
// and the mobile disconnect state. They carry no instance theme, so scoped
// storage must not read or write them: a write would pin whatever theme was
// current at that moment (e.g. cold-boot defaults) to a key every future
// launch resolves before connecting, and a read would surface that stale
// entry on the mobile connect splash. The global splash hints are the right
// fallback for those phases.
const TRANSIENT_RUNTIME_KEYS = new Set(['', 'url:default', 'mobile-disconnected']);

export const isTransientRuntimeKey = (runtimeKey: string): boolean =>
  TRANSIENT_RUNTIME_KEYS.has(runtimeKey);

export const readThemePreferencesForRuntime = (runtimeKey: string): StoredThemePreferences | null => {
  if (typeof window === 'undefined' || isTransientRuntimeKey(runtimeKey)) {
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
  if (typeof window === 'undefined' || isTransientRuntimeKey(runtimeKey)) {
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

// One-time migration seed: pre-scoped builds persisted theme state in these
// global keys. They are resolved only while no scoped entry exists — the
// persist effect then seeds the scoped key from the returned preferences — so
// no client-only theme state is discarded before the authoritative server sync
// lands. The keys themselves stay (see ThemeSystemContext's persist effect):
// the pre-React splash shells and the Android status bar read them as
// cosmetic last-writer-wins hints.
const readLegacyThemePreferences = (): StoredThemePreferences => {
  let themeMode: ThemeMode = 'system';
  let lightThemeId: string = DEFAULT_LIGHT_THEME_ID;
  let darkThemeId: string = DEFAULT_DARK_THEME_ID;

  if (typeof window === 'undefined') {
    return { themeMode, lightThemeId, darkThemeId };
  }

  const legacyMode = localStorage.getItem('themeMode');
  const legacyUseSystem = localStorage.getItem('useSystemTheme');
  const legacyThemeId = localStorage.getItem('selectedThemeId');
  const legacyVariant = localStorage.getItem('selectedThemeVariant');

  if (legacyMode === 'light' || legacyMode === 'dark' || legacyMode === 'system') {
    themeMode = legacyMode;
  } else if (legacyUseSystem !== null) {
    const useSystem = legacyUseSystem === 'true';
    if (useSystem) {
      themeMode = 'system';
    } else if (legacyThemeId) {
      const legacyTheme = getThemeById(legacyThemeId);
      if (legacyTheme) {
        themeMode = legacyTheme.metadata.variant === 'dark' ? 'dark' : 'light';
        if (legacyTheme.metadata.variant === 'dark') {
          darkThemeId = legacyTheme.metadata.id;
        } else {
          lightThemeId = legacyTheme.metadata.id;
        }
      }
    }
  } else if (legacyVariant === 'light' || legacyVariant === 'dark') {
    themeMode = legacyVariant;
  }

  const legacyLightId = localStorage.getItem('lightThemeId');
  const legacyDarkId = localStorage.getItem('darkThemeId');
  if (typeof legacyLightId === 'string' && legacyLightId.trim().length > 0) {
    lightThemeId = legacyLightId.trim();
  }
  if (typeof legacyDarkId === 'string' && legacyDarkId.trim().length > 0) {
    darkThemeId = legacyDarkId.trim();
  }

  return { themeMode, lightThemeId, darkThemeId };
};

/**
 * Resolve the preferences for a runtime at boot: the scoped entry when one
 * exists, otherwise a one-time seed from the superseded global keys, otherwise
 * defaults. The seed guarantees the first scoped write carries the last-known
 * theme instead of defaults.
 */
export const resolveThemePreferencesForRuntime = (runtimeKey: string): StoredThemePreferences => {
  const stored = readThemePreferencesForRuntime(runtimeKey);
  return stored ?? readLegacyThemePreferences();
};

/**
 * Adopt another runtime's stored preferences when the endpoint switches: the
 * new runtime's scoped entry when one exists, otherwise the current
 * preferences unchanged (the same reference — no re-render, no write-through)
 * until the incoming settings sync refines with the server's authoritative
 * value.
 */
export const adoptThemePreferencesForRuntime = (
  runtimeKey: string,
  current: StoredThemePreferences,
): StoredThemePreferences => readThemePreferencesForRuntime(runtimeKey) ?? current;
