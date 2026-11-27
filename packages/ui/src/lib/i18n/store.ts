import { create } from 'zustand';

import { captureRuntimeInstance } from '../runtime-switch';
import { dict as enDict, type I18nKey } from './messages/en';
import { DEFAULT_LOCALE, detectInitialLocale, type Locale, writeStoredLocale } from './runtime';
import { formatTemplate, type I18nParams } from './format';

export type I18nDictionary = Record<I18nKey, string>;

type I18nState = {
  locale: Locale;
  dictionary: I18nDictionary;
  loadingLocale: Locale | null;
  setLocale: (locale: Locale) => Promise<boolean>;
  restoreLocale: () => void;
  applyProfileLocale: (locale: Locale) => Promise<boolean>;
};

const dictionaries = new Map<Locale, I18nDictionary>([[DEFAULT_LOCALE, enDict]]);

type DictionaryImporter = (locale: Locale) => Promise<I18nDictionary>;

let dictionaryImporterOverride: DictionaryImporter | undefined;

export function resetI18nDictionaryCacheForTests(): void {
  dictionaries.clear();
  dictionaries.set(DEFAULT_LOCALE, enDict);
}

export function setI18nDictionaryImporterForTests(importer?: DictionaryImporter): void {
  dictionaryImporterOverride = importer;
}

async function loadDictionary(locale: Locale): Promise<I18nDictionary> {
  const cached = dictionaries.get(locale);
  if (cached) {
    return cached;
  }

  const dict = await (dictionaryImporterOverride ?? importDictionary)(locale);
  dictionaries.set(locale, dict);
  return dict;
}

async function importDictionary(locale: Locale): Promise<I18nDictionary> {
  const mod = locale === 'zh-CN'
    ? await import('./messages/zh-CN') as { dict: I18nDictionary }
    : locale === 'fr'
      ? await import('./messages/fr') as { dict: I18nDictionary }
      : locale === 'nl'
        ? await import('./messages/nl') as { dict: I18nDictionary }
    : locale === 'zh-TW'
      ? await import('./messages/zh-TW') as { dict: I18nDictionary }
      : locale === 'es'
        ? await import('./messages/es') as { dict: I18nDictionary }
        : locale === 'pt-BR'
          ? await import('./messages/pt-BR') as { dict: I18nDictionary }
          : locale === 'uk'
            ? await import('./messages/uk') as { dict: I18nDictionary }
            : locale === 'ko'
              ? await import('./messages/ko') as { dict: I18nDictionary }
              : locale === 'pl'
                ? await import('./messages/pl') as { dict: I18nDictionary }
                : locale === 'de'
                  ? await import('./messages/de') as { dict: I18nDictionary }
                  : locale === 'ja'
                    ? await import('./messages/ja') as { dict: I18nDictionary }
                    : locale === 'tr'
                      ? await import('./messages/tr') as { dict: I18nDictionary }
                      : locale === 'ar'
                        ? await import('./messages/ar')
                        : locale === 'he'
                          ? await import('./messages/he')
                          : { dict: enDict };
  return mod.dict;
}

export const useI18nStore = create<I18nState>()((set, get) => {
  let latestProfileRequest = 0;
  let latestSelection = 0;
  let selectionRevision = 0;
  let profileRevision = 0;
  type PendingLocale = { result: Promise<boolean>; isCurrent: () => boolean };
  let pendingSelection: PendingLocale | undefined;
  let pendingLoad: symbol | undefined;
  let wakeSelectionWaiters = () => {};
  let selectionChanged = new Promise<void>((resolve) => { wakeSelectionWaiters = resolve; });
  const notifySelectionChanged = () => {
    const wake = wakeSelectionWaiters;
    selectionChanged = new Promise<void>((resolve) => { wakeSelectionWaiters = resolve; });
    wake();
  };

  const applyLocale = async (
    locale: Locale,
    kind: 'startup' | 'profile' | 'selection',
    canCommit: () => boolean,
  ): Promise<boolean> => {
    const request = Symbol();
    let dictionary = dictionaries.get(locale);
    const persist = kind !== 'startup' || get().locale !== locale || !dictionary;
    try {
      if (!dictionary) {
        pendingLoad = request;
        set({ loadingLocale: locale });
        dictionary = await loadDictionary(locale);
      }
      while (kind !== 'selection' && canCommit() && pendingSelection?.isCurrent()) {
        await Promise.race([pendingSelection.result, selectionChanged]);
      }
      if (!canCommit()) return false;
      if (kind === 'selection') selectionRevision++;
      if (kind === 'profile') profileRevision++;
      if (persist) writeStoredLocale(locale);
      if (pendingLoad === request) {
        pendingLoad = undefined;
        set({ locale, dictionary, loadingLocale: null });
      } else if (get().locale !== locale) {
        set({ locale, dictionary });
      }
      return true;
    } catch (error) {
      console.error(`[i18n] failed to load locale ${locale}`, error);
      return false;
    } finally {
      if (pendingLoad === request) {
        pendingLoad = undefined;
        set({ loadingLocale: null });
      }
    }
  };

  return {
    locale: DEFAULT_LOCALE,
    dictionary: enDict,
    loadingLocale: null,
    setLocale: async (locale) => {
      const isCurrent = captureRuntimeInstance();
      const request = ++latestSelection;
      const selection = {
        isCurrent,
        result: applyLocale(locale, 'selection', () => request === latestSelection && isCurrent()),
      };
      pendingSelection = selection;
      notifySelectionChanged();
      try {
        return await selection.result;
      } finally {
        if (pendingSelection === selection) {
          pendingSelection = undefined;
          notifySelectionChanged();
        }
      }
    },
    restoreLocale: () => {
      const selection = selectionRevision;
      const profile = profileRevision;
      void applyLocale(detectInitialLocale(), 'startup', () => selection === selectionRevision && profile === profileRevision);
    },
    applyProfileLocale: (locale) => {
      const isCurrent = captureRuntimeInstance();
      const request = ++latestProfileRequest;
      const revision = selectionRevision;
      return applyLocale(locale, 'profile', () => isCurrent() && request === latestProfileRequest && revision === selectionRevision);
    },
  };
});

export function initializeLocale(): void {
  useI18nStore.getState().restoreLocale();
}

export function formatMessage(dictionary: I18nDictionary, key: I18nKey, params?: I18nParams): string {
  return formatTemplate(dictionary[key] ?? enDict[key] ?? key, params);
}

export type { I18nKey, I18nParams, Locale };
