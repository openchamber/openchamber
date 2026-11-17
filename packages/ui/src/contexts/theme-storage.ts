import type { ThemeMode } from '@/types/theme';
import type { DesktopSettings } from '@/lib/desktop';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, getThemeById } from '@/lib/theme/themes';
import { isTransientRuntimeKey } from '@/lib/runtime-switch';

type StoredThemePreferences = {
  themeMode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
};

const THEME_PREFERENCES_KEY_PREFIX = 'openchamber.theme.v2:';

export const getThemePreferencesStorageKey = (runtimeKey: string): string =>
  `${THEME_PREFERENCES_KEY_PREFIX}${encodeURIComponent(runtimeKey)}`;

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

const isThemeMode = (value: string): value is ThemeMode =>
  THEME_MODES.some((mode) => mode === value);

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

export const resolveThemePreferencesForRuntime = (runtimeKey: string): StoredThemePreferences => {
  const stored = readThemePreferencesForRuntime(runtimeKey);
  return stored ?? readLegacyThemePreferences();
};

export const adoptThemePreferencesForRuntime = (
  runtimeKey: string,
  current: StoredThemePreferences,
): StoredThemePreferences => readThemePreferencesForRuntime(runtimeKey) ?? current;

type SettingsSyncThemePayload = Pick<
  DesktopSettings,
  'useSystemTheme' | 'themeVariant' | 'lightThemeId' | 'darkThemeId'
>;

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
