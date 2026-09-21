import { describe, expect, test } from 'bun:test';

import { surfacePanelI18n } from './surface-panel.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

describe('shared surface panel translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english = surfacePanelI18n.en;
    const keys = Object.keys(english) as Array<keyof typeof english>;
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      for (const key of keys) {
        const value = surfacePanelI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });
});
