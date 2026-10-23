import { expect, test } from 'bun:test';
import { LOCALES } from '../runtime';
import { botSpaceI18n } from './bot-space.i18n';
import { botsI18n } from './bots.i18n';

test('makes translated bot space keys available through the bot dictionary in every locale', () => {
  // Given the complete supported locale list and the isolated editor's keys.
  const english: Readonly<Record<string, string>> = botSpaceI18n.en;

  // When each locale is composed into the bot dictionary.
  for (const locale of LOCALES) {
    const translated: Readonly<Record<string, string>> = botSpaceI18n[locale];
    const merged: Readonly<Record<string, string>> = botsI18n[locale];

    // Then all keys resolve to a real translation through the existing import.
    expect(Object.keys(translated)).toEqual(Object.keys(english));
    for (const [key, value] of Object.entries(translated)) {
      expect(merged[key]).toBe(value);
      expect(value.length).toBeGreaterThan(0);
      if (locale !== 'en') expect(value).not.toBe(english[key]);
    }
  }
});
