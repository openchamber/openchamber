import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '@/lib/theme/themes';

import {
  getThemePreferencesStorageKey,
  readThemePreferencesForRuntime,
  resolveThemePreferencesForRuntime,
  resolveThemePreferencesFromStorageEvent,
  writeThemePreferencesForRuntime,
} from './theme-storage';

let createdWindow = false;
let createdLocalStorage = false;

const ensureLocalStorage = (): void => {
  if (typeof localStorage !== 'undefined') {
    return;
  }
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
  createdLocalStorage = true;
};

beforeEach(() => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    createdWindow = true;
  }
  ensureLocalStorage();
  localStorage.clear();
});

afterAll(() => {
  if (createdWindow) {
    delete (globalThis as { window?: unknown }).window;
  }
  if (createdLocalStorage) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

const preferences = {
  themeMode: 'dark' as const,
  lightThemeId: 'light-theme',
  darkThemeId: 'dark-theme',
};

describe('theme preference runtime scoping', () => {
  test('keys differ per runtime', () => {
    expect(getThemePreferencesStorageKey('runtime-a')).not.toBe(getThemePreferencesStorageKey('runtime-b'));
  });

  test('round-trips preferences for the same runtime', () => {
    writeThemePreferencesForRuntime('runtime-a', preferences);

    expect(readThemePreferencesForRuntime('runtime-a')).toEqual(preferences);
  });

  test('a window on one instance never reads another instance theme', () => {
    writeThemePreferencesForRuntime('runtime-a', preferences);

    expect(readThemePreferencesForRuntime('runtime-b')).toBeNull();
  });

  test('latest write wins per runtime without cross-instance effects', () => {
    writeThemePreferencesForRuntime('runtime-a', preferences);
    writeThemePreferencesForRuntime('runtime-b', { themeMode: 'light', lightThemeId: 'other-light', darkThemeId: 'other-dark' });

    expect(readThemePreferencesForRuntime('runtime-a')).toEqual(preferences);
    expect(readThemePreferencesForRuntime('runtime-b')).toEqual({
      themeMode: 'light',
      lightThemeId: 'other-light',
      darkThemeId: 'other-dark',
    });
  });

  test('malformed or invalid payloads are failure, not empty authority', () => {
    localStorage.setItem(getThemePreferencesStorageKey('runtime-a'), 'not-json');
    expect(readThemePreferencesForRuntime('runtime-a')).toBeNull();

    localStorage.setItem(getThemePreferencesStorageKey('runtime-a'), JSON.stringify({ themeMode: 'neon' }));
    expect(readThemePreferencesForRuntime('runtime-a')).toBeNull();

    localStorage.setItem(
      getThemePreferencesStorageKey('runtime-a'),
      JSON.stringify({ themeMode: 'dark', lightThemeId: '', darkThemeId: 'dark-theme' }),
    );
    expect(readThemePreferencesForRuntime('runtime-a')).toBeNull();
  });

  test('removes superseded global theme keys once the scoped key is written', () => {
    localStorage.setItem('themeMode', 'dark');
    localStorage.setItem('lightThemeId', 'light-theme');
    localStorage.setItem('darkThemeId', 'dark-theme');
    localStorage.setItem('useSystemTheme', 'false');
    localStorage.setItem('selectedThemeId', 'dark-theme');
    localStorage.setItem('selectedThemeVariant', 'dark');
    localStorage.setItem('splashBgDark', '#0c0a09');
    localStorage.setItem('splashFgDark', '#fafaf9');

    writeThemePreferencesForRuntime('runtime-a', preferences);

    expect(localStorage.getItem('themeMode')).toBeNull();
    expect(localStorage.getItem('lightThemeId')).toBeNull();
    expect(localStorage.getItem('darkThemeId')).toBeNull();
    expect(localStorage.getItem('useSystemTheme')).toBeNull();
    expect(localStorage.getItem('selectedThemeId')).toBeNull();
    expect(localStorage.getItem('selectedThemeVariant')).toBeNull();
    expect(localStorage.getItem('splashBgDark')).toBeNull();
    expect(localStorage.getItem('splashFgDark')).toBeNull();
    expect(readThemePreferencesForRuntime('runtime-a')).toEqual(preferences);
  });
});

describe('theme preference resolution chain', () => {
  test('uses the scoped entry when present', () => {
    writeThemePreferencesForRuntime('runtime-a', preferences);

    expect(resolveThemePreferencesForRuntime('runtime-a')).toEqual(preferences);
  });

  test('seeds from the legacy mode and theme ids when no scoped entry exists', () => {
    localStorage.setItem('themeMode', 'dark');
    localStorage.setItem('lightThemeId', 'legacy-light');
    localStorage.setItem('darkThemeId', 'legacy-dark');

    expect(resolveThemePreferencesForRuntime('runtime-a')).toEqual({
      themeMode: 'dark',
      lightThemeId: 'legacy-light',
      darkThemeId: 'legacy-dark',
    });
  });

  test('seeds from the useSystemTheme/selectedThemeId legacy chain', () => {
    localStorage.setItem('useSystemTheme', 'false');
    localStorage.setItem('selectedThemeId', DEFAULT_DARK_THEME_ID);

    expect(resolveThemePreferencesForRuntime('runtime-a')).toEqual({
      themeMode: 'dark',
      lightThemeId: DEFAULT_LIGHT_THEME_ID,
      darkThemeId: DEFAULT_DARK_THEME_ID,
    });
  });

  test('falls back to defaults when nothing is stored', () => {
    expect(resolveThemePreferencesForRuntime('runtime-a')).toEqual({
      themeMode: 'system',
      lightThemeId: DEFAULT_LIGHT_THEME_ID,
      darkThemeId: DEFAULT_DARK_THEME_ID,
    });
  });

  test('the migrated seed survives into the scoped key with legacy keys removed', () => {
    localStorage.setItem('themeMode', 'dark');
    localStorage.setItem('lightThemeId', 'legacy-light');
    localStorage.setItem('darkThemeId', 'legacy-dark');

    writeThemePreferencesForRuntime('runtime-a', resolveThemePreferencesForRuntime('runtime-a'));

    expect(readThemePreferencesForRuntime('runtime-a')).toEqual({
      themeMode: 'dark',
      lightThemeId: 'legacy-light',
      darkThemeId: 'legacy-dark',
    });
    expect(localStorage.getItem('themeMode')).toBeNull();
    expect(localStorage.getItem('lightThemeId')).toBeNull();
    expect(localStorage.getItem('darkThemeId')).toBeNull();
  });
});

describe('theme storage event resolution', () => {
  const current = { themeMode: 'system' as const, lightThemeId: 'light-theme', darkThemeId: 'dark-theme' };

  test('adopts a storage event for the current runtime', () => {
    writeThemePreferencesForRuntime('runtime-a', preferences);

    expect(resolveThemePreferencesFromStorageEvent(getThemePreferencesStorageKey('runtime-a'), 'runtime-a', current)).toEqual(preferences);
  });

  test('ignores a storage event from another runtime', () => {
    writeThemePreferencesForRuntime('runtime-b', preferences);

    expect(resolveThemePreferencesFromStorageEvent(getThemePreferencesStorageKey('runtime-b'), 'runtime-a', current)).toBeNull();
  });

  test('ignores legacy global theme keys (revert-to-globals regression guard)', () => {
    localStorage.setItem('themeMode', 'dark');
    localStorage.setItem('lightThemeId', 'light-theme');
    localStorage.setItem('darkThemeId', 'dark-theme');

    expect(resolveThemePreferencesFromStorageEvent('themeMode', 'runtime-a', current)).toBeNull();
    expect(resolveThemePreferencesFromStorageEvent('lightThemeId', 'runtime-a', current)).toBeNull();
    expect(resolveThemePreferencesFromStorageEvent('darkThemeId', 'runtime-a', current)).toBeNull();
  });

  test('resolves to no change when stored preferences already match', () => {
    writeThemePreferencesForRuntime('runtime-a', preferences);

    expect(resolveThemePreferencesFromStorageEvent(getThemePreferencesStorageKey('runtime-a'), 'runtime-a', preferences)).toBeNull();
  });

  test('resolves to no change when nothing valid is stored', () => {
    expect(resolveThemePreferencesFromStorageEvent(getThemePreferencesStorageKey('runtime-a'), 'runtime-a', current)).toBeNull();

    localStorage.setItem(getThemePreferencesStorageKey('runtime-a'), 'not-json');
    expect(resolveThemePreferencesFromStorageEvent(getThemePreferencesStorageKey('runtime-a'), 'runtime-a', current)).toBeNull();
  });
});
