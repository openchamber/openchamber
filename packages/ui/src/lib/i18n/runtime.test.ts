import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { getLocaleDirection, isRightToLeft, LOCALES, normalizeLocale } from './runtime';

describe('i18n runtime', () => {
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
