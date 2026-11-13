import { describe, expect, test } from 'bun:test';

import { protectedMcpI18n } from './protected-mcp.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('protected MCP translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = protectedMcpI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = protectedMcpI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        expect(value.match(/\{[^}]+\}/g) ?? []).toEqual(english[key].match(/\{[^}]+\}/g) ?? []);
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });

  test('keeps stand-alone tooltip sentences distinct from notice leads in every locale', () => {
    // Given
    for (const locale of locales) {
      const translated = protectedMcpI18n[locale];
      for (const status of ['unverified', 'unprotected'] as const) {
        // When
        const tooltip = translated[`settings.mcp.protected.enforcement.${status}Info`];
        const lead = translated[`settings.mcp.protected.notice.${status}Lead`];
        // Then
        expect(/[：:]$/.test(tooltip)).toBe(false);
        expect(/[：:]$/.test(lead)).toBe(true);
        expect(tooltip).not.toBe(lead);
      }
    }
  });
});
