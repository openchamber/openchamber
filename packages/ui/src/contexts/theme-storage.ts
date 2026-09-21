import type { ThemeMode } from '@/types/theme';
import type { DesktopSettings } from '@/lib/desktop';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, getThemeById } from '@/lib/theme/themes';
import { isTransientRuntimeKey } from '@/lib/runtime-switch';

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

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

const isThemeMode = (value: string): value is ThemeMode =>
  THEME_MODES.some((mode) => mode === value);

// Boundary parser for the scoped entry. A malformed or partial payload is a
// failure (`null`), never a valid default: the caller then falls back to the
// legacy seed or keeps its current preferences.
const parseStoredThemePreferences = (raw: string): StoredThemePreferences | null => {
  try {
    // SAFETY: this key is written only by `writeThemePreferencesForRuntime`
    // with exactly this shape. Every field is still re-checked below, and a
    // field of the wrong type throws on `.trim()` into the catch.
    const candidate = JSON.parse(raw) as Partial<StoredThemePreferences> | null;
    if (candidate === null) {
      return null;
    }
    const themeMode = candidate.themeMode ?? '';
    if (!isThemeMode(themeMode)) {
      return null;
    }
    const lightThemeId = (candidate.lightThemeId ?? '').trim();
    const darkThemeId = (candidate.darkThemeId ?? '').trim();
    if (!lightThemeId || !darkThemeId) {
      return null;
    }
    return { themeMode, lightThemeId, darkThemeId };
  } catch {
    return null;
  }
};

const readLocalStorageItem = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const readThemePreferencesForRuntime = (runtimeKey: string): StoredThemePreferences | null => {
  if (isTransientRuntimeKey(runtimeKey)) {
    return null;
  }
  const raw = readLocalStorageItem(getThemePreferencesStorageKey(runtimeKey));
  return raw ? parseStoredThemePreferences(raw) : null;
};

export const writeThemePreferencesForRuntime = (runtimeKey: string, preferences: StoredThemePreferences): void => {
  if (isTransientRuntimeKey(runtimeKey)) {
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

  const legacyMode = readLocalStorageItem('themeMode');
  const legacyUseSystem = readLocalStorageItem('useSystemTheme');
  const legacyThemeId = readLocalStorageItem('selectedThemeId');
  const legacyVariant = readLocalStorageItem('selectedThemeVariant');

  if (legacyMode !== null && isThemeMode(legacyMode)) {
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

  const legacyLightId = readLocalStorageItem('lightThemeId')?.trim();
  const legacyDarkId = readLocalStorageItem('darkThemeId')?.trim();
  if (legacyLightId) {
    lightThemeId = legacyLightId;
  }
  if (legacyDarkId) {
    darkThemeId = legacyDarkId;
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

type SettingsSyncThemePayload = Pick<
  DesktopSettings,
  'useSystemTheme' | 'themeVariant' | 'lightThemeId' | 'darkThemeId'
>;

/**
 * Resolve the preferences a settings sync should apply. Returns null — meaning
 * "keep current preferences" — when the sync is not bootstrap-grade (a
 * mid-session save echo replays the server document, which may hold another
 * window's theme, a default, or a stale value; the scoped entry and bootstrap
 * syncs own this window's theme) and when the resolved values already match
 * the current ones (the identity check breaks adoption loops).
 *
 * Theme fields absent from the server document mean "not set", not "reset to
 * defaults": each one independently keeps the current preference. The payload
 * is the already-sanitized settings document (sanitizeWebSettings), so fields
 * present in it are domain-valid; an unknown id injected some other way fails
 * theme lookup downstream and falls back cosmetically.
 */
export const resolveThemePreferencesFromSettingsSync = (
  detail: { adoptTheme: boolean; settings: SettingsSyncThemePayload } | null,
  current: StoredThemePreferences,
): StoredThemePreferences | null => {
  if (!detail?.adoptTheme) {
    return null;
  }

  const settings = detail.settings;
  let themeMode = current.themeMode;
  if (settings.useSystemTheme === true) {
    themeMode = 'system';
  } else if (settings.useSystemTheme === false && (settings.themeVariant === 'dark' || settings.themeVariant === 'light')) {
    themeMode = settings.themeVariant;
  }

  const lightThemeId = settings.lightThemeId?.trim() || current.lightThemeId;
  const darkThemeId = settings.darkThemeId?.trim() || current.darkThemeId;

  if (themeMode === current.themeMode && lightThemeId === current.lightThemeId && darkThemeId === current.darkThemeId) {
    return null;
  }

  return { themeMode, lightThemeId, darkThemeId };
};
