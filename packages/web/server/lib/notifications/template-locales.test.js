import fsPromises from 'fs/promises';

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

describe('notification defaults match the settings page', () => {
  // The settings page renders these keys as the placeholder of an empty field,
  // so the text the server sends has to be the same string. Read from disk:
  // the server cannot import packages/ui, which is why the mirror exists.
  const readUiDefaults = async (locale) => {
    const file = new URL(`../../../../ui/src/lib/i18n/messages/${locale}.settings.ts`, import.meta.url);
    const source = await fsPromises.readFile(file, 'utf8');
    const value = async (key) => {
      const match = source.match(new RegExp(`['"]settings\\.notifications\\.page\\.template\\.defaults\\.${key}['"]:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`));
      if (!match) throw new Error(`${locale} has no ${key}`);
      return match[2].replace(/\\(['"])/g, '$1');
    };
    return {
      completion: { title: await value('completion\\.title'), message: await value('completion\\.message') },
      subtask: { title: await value('subtask\\.title'), message: await value('subtask\\.message') },
      errorTitle: await value('error\\.title'),
      questionTitle: await value('question\\.title'),
    };
  };

  it('sends the text the placeholder promises, in every language', async () => {
    for (const locale of Object.keys(NOTIFICATION_TEXT_BY_LOCALE)) {
      const ui = await readUiDefaults(locale);
      const server = defaultNotificationTemplates(locale);
      expect(server.completion, locale).toEqual(ui.completion);
      expect(server.subtask, locale).toEqual(ui.subtask);
      expect(server.error, locale).toEqual({ title: ui.errorTitle, message: '{last_message}' });
      expect(server.question, locale).toEqual({ title: ui.questionTitle, message: '{last_message}' });
    }
  });
});
