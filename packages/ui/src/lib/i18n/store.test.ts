import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '../runtime-switch';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, type Locale } from './runtime';
import {
  resetI18nDictionaryCacheForTests,
  setI18nDictionaryImporterForTests,
  useI18nStore,
  type I18nDictionary,
} from './store';

const defaultDictionary = useI18nStore.getState().dictionary;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const dictionaryFor = (locale: Locale): I18nDictionary => ({ ...defaultDictionary, 'common.language.french': `French in ${locale}` });

// Startup reads the browser's language through `window`, as it does in a browser.
const withBrowserLanguage = async (locale: Locale, run: (storage: Map<string, string>) => Promise<void>) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      __OPENCHAMBER_HOST_LANGUAGE__: locale,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  });
  try {
    await run(storage);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
};

const resetStore = () => {
  setI18nDictionaryImporterForTests();
  resetI18nDictionaryCacheForTests();
  useI18nStore.setState({
    locale: DEFAULT_LOCALE,
    dictionary: defaultDictionary,
    loadingLocale: null,
  });
};

describe('i18n store', () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  test('keeps the active locale and its dictionary while Arabic loads', async () => {
    const applied = useI18nStore.getState().setLocale('ar');
    try {
      expect(useI18nStore.getState().loadingLocale).toBe('ar');
      expect(useI18nStore.getState().locale).toBe('en');
      expect(useI18nStore.getState().dictionary).toBe(defaultDictionary);
    } finally {
      await applied;
    }
    expect(await applied).toBe(true);
    expect(useI18nStore.getState().locale).toBe('ar');
  });

  test('loads the French dictionary', async () => {
    expect(await useI18nStore.getState().setLocale('fr')).toBe(true);
    expect(useI18nStore.getState().dictionary['common.language.french']).toBe('Français');
  });

  test('only applies the latest request when the same locale is requested again', async () => {
    const { setLocale } = useI18nStore.getState();
    const first = setLocale('ar');
    const second = setLocale('en');
    const third = setLocale('ar');

    expect(await Promise.all([first, second, third])).toEqual([false, true, true]);
    expect(useI18nStore.getState().locale).toBe('ar');
    expect(useI18nStore.getState().loadingLocale).toBeNull();
  });

  test('keeps a pending picker choice when profile settings arrive', async () => {
    const { setLocale, applyProfileLocale } = useI18nStore.getState();
    const selection = setLocale('ar');

    const profile = applyProfileLocale('fr');
    expect(await selection).toBe(true);
    expect(await profile).toBe(false);
    expect(useI18nStore.getState().locale).toBe('ar');
  });

  test('ignores a profile load from a retired runtime', async () => {
    const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    const restored = useI18nStore.getState().applyProfileLocale('he');
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://second.test' });
      expect(await restored).toBe(false);
      expect(useI18nStore.getState().locale).toBe('en');
      expect(useI18nStore.getState().loadingLocale).toBeNull();
    } finally {
      switchRuntimeEndpoint(previous);
    }
  });

  test('does not let an abandoned picker request hold a loaded profile locale', async () => {
    const arabic = deferred<I18nDictionary>();
    setI18nDictionaryImporterForTests((locale) => {
      if (locale === 'ar') return arabic.promise;
      if (locale === 'he') return Promise.reject(new Error('no he chunk'));
      return Promise.resolve(dictionaryFor(locale));
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const { setLocale, applyProfileLocale } = useI18nStore.getState();
      const abandoned = setLocale('ar');
      const profile = applyProfileLocale('fr');
      await settle();

      expect(await setLocale('he')).toBe(false);
      expect(await profile).toBe(true);
      expect(useI18nStore.getState().locale).toBe('fr');

      arabic.resolve(dictionaryFor('ar'));
      expect(await abandoned).toBe(false);
      expect(useI18nStore.getState().locale).toBe('fr');
    } finally {
      console.error = originalError;
    }
  });

  test('startup in the already active English leaves the browser preference unset', async () => {
    await withBrowserLanguage('en', async (storage) => {
      useI18nStore.getState().restoreLocale();
      await settle();
      expect(useI18nStore.getState().locale).toBe('en');
      expect(storage.has(LOCALE_STORAGE_KEY)).toBe(false);

      expect(await useI18nStore.getState().setLocale('en')).toBe(true);
      expect(JSON.parse(storage.get(LOCALE_STORAGE_KEY) ?? '{}')).toEqual({ locale: 'en' });
    });
  });

  describe('while the startup dictionary is pending', () => {
    test('applies a loadable profile locale and ignores the late startup result', async () => {
      const startup = deferred<I18nDictionary>();
      setI18nDictionaryImporterForTests((locale) => (locale === 'ar' ? startup.promise : Promise.resolve(dictionaryFor(locale))));

      await withBrowserLanguage('ar', async (storage) => {
        useI18nStore.getState().restoreLocale();
        expect(useI18nStore.getState().loadingLocale).toBe('ar');

        expect(await useI18nStore.getState().applyProfileLocale('fr')).toBe(true);
        expect(useI18nStore.getState().locale).toBe('fr');

        startup.resolve(dictionaryFor('ar'));
        await settle();

        expect(useI18nStore.getState().locale).toBe('fr');
        expect(useI18nStore.getState().dictionary['common.language.french']).toBe('French in fr');
        expect(useI18nStore.getState().loadingLocale).toBeNull();
        expect(JSON.parse(storage.get(LOCALE_STORAGE_KEY) ?? '{}')).toEqual({ locale: 'fr' });
      });
    });

    test('keeps the startup locale available when the profile locale fails to load', async () => {
      const startup = deferred<I18nDictionary>();
      setI18nDictionaryImporterForTests((locale) => (
        locale === 'ar' ? startup.promise : Promise.reject(new Error(`no ${locale} chunk`))
      ));
      const originalError = console.error;
      console.error = () => {};

      try {
        await withBrowserLanguage('ar', async (storage) => {
          useI18nStore.getState().restoreLocale();

          expect(await useI18nStore.getState().applyProfileLocale('fr')).toBe(false);
          expect(useI18nStore.getState().locale).toBe('en');

          startup.resolve(dictionaryFor('ar'));
          await settle();

          expect(useI18nStore.getState().locale).toBe('ar');
          expect(useI18nStore.getState().dictionary['common.language.french']).toBe('French in ar');
          expect(useI18nStore.getState().loadingLocale).toBeNull();
          expect(JSON.parse(storage.get(LOCALE_STORAGE_KEY) ?? '{}')).toEqual({ locale: 'ar' });
        });
      } finally {
        console.error = originalError;
      }
    });
  });
});
