import { describe, expect, test } from 'bun:test';

import { LOCALES } from '../runtime';
import { openchamberToolsLayoutI18n } from './openchamber-tools-layout.i18n';

describe('OpenChamber Tools layout translations', () => {
  test('every locale has every key, filled in', () => {
    const englishKeys = Object.keys(openchamberToolsLayoutI18n.en).sort();
    for (const locale of LOCALES) {
      const dictionary: Record<string, string> = openchamberToolsLayoutI18n[locale];
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(dictionary[key]?.trim()).toBeTruthy();
      }
    }
  });

  test('group headings are translated, not copied from English', () => {
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      for (const key of ['settings.openchamber.tools.group.work', 'settings.openchamber.tools.group.chat', 'settings.openchamber.tools.group.knowledge'] as const) {
        expect(`${locale} ${openchamberToolsLayoutI18n[locale][key]}`).not.toBe(`${locale} ${openchamberToolsLayoutI18n.en[key]}`);
      }
    }
  });
});
