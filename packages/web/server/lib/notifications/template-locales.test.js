import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_TEXT_BY_LOCALE,
  defaultNotificationTemplates,
  normalizeNotificationLocale,
  notificationTexts,
  withTemplateDefaults,
} from './template-locales.js';

const locales = Object.keys(NOTIFICATION_TEXT_BY_LOCALE);
const textFields = Object.keys(NOTIFICATION_TEXT_BY_LOCALE.en);

describe('notification template locales', () => {
  it('gives every locale the same fields and no empty ones', () => {
    for (const locale of locales) {
      const texts = NOTIFICATION_TEXT_BY_LOCALE[locale];
      expect(Object.keys(texts).sort()).toEqual([...textFields].sort());
      for (const field of textFields) {
        expect(texts[field].trim().length, `${locale}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the notification template variables in every language', () => {
    for (const locale of locales) {
      const texts = NOTIFICATION_TEXT_BY_LOCALE[locale];
      expect(texts.readyTitle, locale).toContain('{agent_name}');
      expect(texts.readyMessage, locale).toContain('{model_name}');
    }
  });

  it('matches a language tag the way a runtime reports it', () => {
    expect(normalizeNotificationLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeNotificationLocale('zh-cn')).toBe('zh-CN');
    expect(normalizeNotificationLocale('zh_TW')).toBe('zh-TW');
    expect(normalizeNotificationLocale('pt-BR')).toBe('pt-BR');
    expect(normalizeNotificationLocale('pt_br')).toBe('pt-BR');
    expect(normalizeNotificationLocale('fr-CA')).toBe('fr');
    expect(normalizeNotificationLocale('de-DE')).toBe('de');
    expect(normalizeNotificationLocale('ko-KR')).toBe('ko');
  });

  it('falls back to English for a tag it does not know', () => {
    expect(normalizeNotificationLocale('')).toBe('en');
    expect(normalizeNotificationLocale(undefined)).toBe('en');
    expect(normalizeNotificationLocale('xx-YY')).toBe('en');
    expect(notificationTexts('xx-YY')).toBe(NOTIFICATION_TEXT_BY_LOCALE.en);
  });

  it('builds the four templates from the language of the caller', () => {
    const zh = defaultNotificationTemplates('zh-CN');
    expect(zh.completion).toEqual({ title: '{agent_name} 已完成', message: '{model_name} 已完成任务' });
    expect(zh.subtask).toEqual(zh.completion);
    expect(zh.error).toEqual({ title: '工具错误', message: '{last_message}' });
    expect(zh.question).toEqual({ title: '需要输入', message: '{last_message}' });
  });

  it('takes the default for an empty field and keeps the one the user wrote', () => {
    const defaults = defaultNotificationTemplates('de');
    expect(withTemplateDefaults({ title: '', message: '' }, defaults.completion)).toEqual(defaults.completion);
    expect(withTemplateDefaults({ title: 'Fertig', message: '' }, defaults.completion))
      .toEqual({ title: 'Fertig', message: defaults.completion.message });
    expect(withTemplateDefaults({ title: '   ', message: 'Meins' }, defaults.completion))
      .toEqual({ title: defaults.completion.title, message: 'Meins' });
    expect(withTemplateDefaults(undefined, defaults.error)).toEqual(defaults.error);
  });
});
