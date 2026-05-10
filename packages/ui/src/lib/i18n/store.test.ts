import { describe, expect, test } from 'bun:test';
import { DEFAULT_LOCALE } from './runtime';
import { useI18nStore } from './store';

describe('i18n store', () => {
  test('retries loading the active locale when it is not cached', () => {
    const defaultDictionary = useI18nStore.getState().dictionary;
    useI18nStore.setState({
      locale: 'es',
      dictionary: defaultDictionary,
      loadingLocale: null,
    });

    try {
      useI18nStore.getState().setLocale('es');

      expect(useI18nStore.getState().loadingLocale).toBe('es');
    } finally {
      useI18nStore.setState({
        locale: DEFAULT_LOCALE,
        dictionary: defaultDictionary,
        loadingLocale: null,
      });
    }
  });
});
