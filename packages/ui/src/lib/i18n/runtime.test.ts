import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { detectInitialLocale, getLocaleDirection, isRightToLeft, LOCALES, LOCALE_STORAGE_KEY, normalizeLocale } from './runtime';

describe('i18n runtime', () => {
  test('uses the first supported browser language after any unsupported choices', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const win = new Window({ url: 'http://localhost' });
    Object.defineProperty(win.navigator, 'languages', { value: ['ru-RU', 'uk-UA', 'fr-FR'], configurable: true });
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
    try {
      expect(detectInitialLocale()).toBe('uk');
      window.__OPENCHAMBER_HOST_LANGUAGE__ = 'de-DE';
      expect(detectInitialLocale()).toBe('de');
      win.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale: 'es' }));
      expect(detectInitialLocale()).toBe('es');
      win.localStorage.removeItem(LOCALE_STORAGE_KEY);
      delete window.__OPENCHAMBER_HOST_LANGUAGE__;
      Object.defineProperty(win.navigator, 'languages', { value: ['en-GB', 'de-DE'], configurable: true });
      expect(detectInitialLocale()).toBe('en');
      Object.defineProperty(win.navigator, 'languages', { value: ['pt-PT', 'fr-CA'], configurable: true });
      expect(detectInitialLocale()).toBe('fr');
      Object.defineProperty(win.navigator, 'languages', { value: ['ru-RU'], configurable: true });
      expect(detectInitialLocale()).toBe('en');
      Object.defineProperty(win.navigator, 'languages', { value: [], configurable: true });
      expect(detectInitialLocale()).toBe('en');
      Object.defineProperty(win.navigator, 'languages', { value: ['zh-Hant-HK'], configurable: true });
      expect(detectInitialLocale()).toBe('zh-TW');
      Object.defineProperty(win.navigator, 'languages', { value: ['zh-HK'], configurable: true });
      expect(detectInitialLocale()).toBe('zh-TW');
      Object.defineProperty(win.navigator, 'languages', { value: ['zh-MO'], configurable: true });
      expect(detectInitialLocale()).toBe('zh-TW');
      win.localStorage.setItem(LOCALE_STORAGE_KEY, '{broken');
      expect(detectInitialLocale()).toBe('zh-TW');
      window.__OPENCHAMBER_HOST_LANGUAGE__ = 'unsupported';
      expect(detectInitialLocale()).toBe('en');
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
      void win.happyDOM.close();
    }
  });

  test('Arabic and Hebrew lay the app out right to left and every other locale left to right', () => {
    for (const locale of LOCALES) {
      expect(getLocaleDirection(locale)).toBe(locale === 'ar' || locale === 'he' ? 'rtl' : 'ltr');
    }
  });

  test('regional Arabic tags resolve to Arabic', () => {
    expect(normalizeLocale('ar')).toBe('ar');
    expect(normalizeLocale('ar-EG')).toBe('ar');
    expect(normalizeLocale('ar_SA')).toBe('ar');
  });

  test('Hebrew resolves from its current and its retired language code', () => {
    expect(normalizeLocale('he-IL')).toBe('he');
    expect(normalizeLocale('iw')).toBe('he');
    expect(normalizeLocale('iw-IL')).toBe('he');
  });

  test('an element takes the direction of its nearest explicit dir', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: new Window().document, configurable: true });
    try {
      document.documentElement.setAttribute('dir', 'rtl');
      document.body.innerHTML = '<div id="row"><span id="title" dir="auto">x</span></div><pre dir="ltr"><code id="code">x</code></pre>';
      const element = (id: string) => {
        const found = document.getElementById(id);
        if (!found) throw new Error(`missing #${id}`);
        return found;
      };
      expect(isRightToLeft(element('row'))).toBe(true);
      expect(isRightToLeft(element('title'))).toBe(true);
      expect(isRightToLeft(element('code'))).toBe(false);
      document.documentElement.setAttribute('dir', 'ltr');
      expect(isRightToLeft(element('row'))).toBe(false);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });
});
