import { expect, test } from 'bun:test';
import { protectedMcpPageI18n } from './protected-mcp-page.i18n';
import { LOCALES } from '../runtime';

test('protected MCP page translations have complete keys, real translations and matching placeholders', async () => {
  // Given the English messages and the supported locales.
  const english: Readonly<Record<string, string>> = protectedMcpPageI18n.en;
  const keys = Object.keys(english);
  expect(keys.length).toBeGreaterThan(0);
  for (const locale of LOCALES) {
    const messages: Readonly<Record<string, string>> = protectedMcpPageI18n[locale];
    // When the main dictionary is loaded as the language switch loads it.
    const { dict } = await import(`./${locale}`);
    // Then every translated message is registered and preserves its parameters.
    expect(Object.keys(messages)).toEqual(keys);
    for (const key of keys) {
      const value = messages[key];
      expect(value).toBeTruthy();
      if (locale !== 'en') expect(value).not.toBe(english[key]);
      expect(value?.match(/\{\w+\}/g) ?? []).toEqual(english[key]?.match(/\{\w+\}/g) ?? []);
      expect(dict[key]).toBe(value);
    }
  }
});
