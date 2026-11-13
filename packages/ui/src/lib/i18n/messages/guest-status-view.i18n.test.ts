import { describe, expect, test } from 'bun:test';

import { guestStatusViewI18n } from './guest-status-view.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('extension status view translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = guestStatusViewI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = guestStatusViewI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        expect(translated[key]).toBeTruthy();
        if (locale !== 'en') expect(translated[key]).not.toBe(english[key]);
      }
    }
  });

  test('chart hover labels keep their value and seconds in every locale', () => {
    for (const locale of locales) {
      expect(guestStatusViewI18n[locale]['chat.workStatus.guestView.pointNow']).toContain('{value}');
      expect(guestStatusViewI18n[locale]['chat.workStatus.guestView.pointAgo']).toContain('{value}');
      expect(guestStatusViewI18n[locale]['chat.workStatus.guestView.pointAgo']).toContain('{seconds}');
    }
  });
});
