import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '@/lib/theme/themes';

import {
  adoptThemePreferencesForRuntime,
  getThemePreferencesStorageKey,
  isTransientRuntimeKey,
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

  test('leaves the splash-hint and migration-seed globals untouched', () => {
    localStorage.setItem('themeMode', 'dark');
    localStorage.setItem('lightThemeId', 'light-theme');
    localStorage.setItem('darkThemeId', 'dark-theme');
    localStorage.setItem('useSystemTheme', 'false');
    localStorage.setItem('selectedThemeId', 'dark-theme');
    localStorage.setItem('selectedThemeVariant', 'dark');
    localStorage.setItem('splashBgDark', '#0c0a09');
    localStorage.setItem('splashFgDark', '#fafaf9');

    writeThemePreferencesForRuntime('runtime-a', preferences);

    // The scoped key owns the app theme; the global keys stay as cosmetic
    // last-writer-wins hints for the pre-React splash shells and the Android
    // status bar, and as the one-time migration seed for new runtimes.
    expect(localStorage.getItem('themeMode')).toBe('dark');
    expect(localStorage.getItem('lightThemeId')).toBe('light-theme');
    expect(localStorage.getItem('darkThemeId')).toBe('dark-theme');
    expect(localStorage.getItem('useSystemTheme')).toBe('false');
    expect(localStorage.getItem('selectedThemeId')).toBe('dark-theme');
    expect(localStorage.getItem('selectedThemeVariant')).toBe('dark');
    expect(localStorage.getItem('splashBgDark')).toBe('#0c0a09');
    expect(localStorage.getItem('splashFgDark')).toBe('#fafaf9');
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

  test('the migrated seed survives into the scoped key while the seed globals stay', () => {
    localStorage.setItem('themeMode', 'dark');
    localStorage.setItem('lightThemeId', 'legacy-light');
    localStorage.setItem('darkThemeId', 'legacy-dark');

    writeThemePreferencesForRuntime('runtime-a', resolveThemePreferencesForRuntime('runtime-a'));

    expect(readThemePreferencesForRuntime('runtime-a')).toEqual({
      themeMode: 'dark',
      lightThemeId: 'legacy-light',
      darkThemeId: 'legacy-dark',
    });
    expect(localStorage.getItem('themeMode')).toBe('dark');
    expect(localStorage.getItem('lightThemeId')).toBe('legacy-light');
    expect(localStorage.getItem('darkThemeId')).toBe('legacy-dark');
  });
});

describe('runtime-switch adoption', () => {
  const current = { themeMode: 'dark' as const, lightThemeId: 'current-light', darkThemeId: 'current-dark' };

  test('adopts the target runtime stored theme when one exists', () => {
    writeThemePreferencesForRuntime('runtime-b', preferences);

    expect(adoptThemePreferencesForRuntime('runtime-b', current)).toEqual(preferences);
  });

  test('keeps the current preferences — same reference — when the target runtime has no entry', () => {
    expect(adoptThemePreferencesForRuntime('runtime-empty', current)).toBe(current);
  });
});

describe('transient runtime keys', () => {
  test('uninitialized and disconnected runtime keys are transient', () => {
    expect(isTransientRuntimeKey('url:default')).toBe(true);
    expect(isTransientRuntimeKey('mobile-disconnected')).toBe(true);
    expect(isTransientRuntimeKey('')).toBe(true);
    expect(isTransientRuntimeKey('local')).toBe(false);
    expect(isTransientRuntimeKey('url:https://host.example')).toBe(false);
  });

  test('writes are skipped for transient runtimes — no stale cold-boot theme gets pinned', () => {
    writeThemePreferencesForRuntime('url:default', preferences);
    writeThemePreferencesForRuntime('mobile-disconnected', preferences);

    expect(readThemePreferencesForRuntime('url:default')).toBeNull();
    expect(readThemePreferencesForRuntime('mobile-disconnected')).toBeNull();
    expect(localStorage.getItem(getThemePreferencesStorageKey('url:default'))).toBeNull();
  });

  test('reads never surface an entry under a transient key', () => {
    localStorage.setItem(getThemePreferencesStorageKey('url:default'), JSON.stringify(preferences));

    expect(readThemePreferencesForRuntime('url:default')).toBeNull();
  });

  test('boot resolution falls back to the global splash hints for transient runtimes', () => {
    localStorage.setItem('themeMode', 'light');
    localStorage.setItem('lightThemeId', 'legacy-light');
    localStorage.setItem('darkThemeId', 'legacy-dark');

    expect(resolveThemePreferencesForRuntime('url:default')).toEqual({
      themeMode: 'light',
      lightThemeId: 'legacy-light',
      darkThemeId: 'legacy-dark',
    });
  });

  test('endpoint-switch adoption keeps current preferences for transient runtimes', () => {
    const current = { themeMode: 'light' as const, lightThemeId: 'light-theme', darkThemeId: 'dark-theme' };

    expect(adoptThemePreferencesForRuntime('mobile-disconnected', current)).toBe(current);
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
