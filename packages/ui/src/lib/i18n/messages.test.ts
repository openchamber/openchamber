import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './messages/en';
import { dict as esDict } from './messages/es';
import { dict as deDict } from './messages/de';
import { dict as frDict } from './messages/fr';
import { dict as nlDict } from './messages/nl';
import { dict as jaDict } from './messages/ja';
import { dict as koDict } from './messages/ko';
import { dict as plDict } from './messages/pl';
import { dict as ptBrDict } from './messages/pt-BR';
import { dict as ukDict } from './messages/uk';
import { dict as zhCnDict } from './messages/zh-CN';
import { dict as zhTwDict } from './messages/zh-TW';
import { dict as trDict } from './messages/tr';
import { dict as arDict } from './messages/ar';
import { dict as heDict } from './messages/he';
import { routingI18n } from './messages/routing.i18n';
import { sessionErrorRecoveryI18n } from './messages/session-error-recovery.i18n';

const localeDictionaries = {
  en: enDict,
  de: deDict,
  fr: frDict,
  nl: nlDict,
  es: esDict,
  ja: jaDict,
  'pt-BR': ptBrDict,
  uk: ukDict,
  ko: koDict,
  pl: plDict,
  'zh-CN': zhCnDict,
  'zh-TW': zhTwDict,
  tr: trDict,
  ar: arDict,
  he: heDict,
} as const;

describe('i18n dictionaries', () => {
  test('repository links name either provider in every locale', () => {
    for (const dictionary of Object.values(localeDictionaries)) {
      expect(dictionary['gitView.header.openRepository']).toContain('{provider}');
    }
  });
  test('anonymous transport has a translated read-only label in every locale', () => {
    const key = 'settings.sourceControl.transport.anonymous';
    expect(enDict[key]).toBe('Anonymous HTTPS, read-only');
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary[key]).toBeTruthy();
      if (locale !== 'en') expect(dictionary[key]).not.toBe(enDict[key]);
    }
  });

  test('double-paste settings copy is translated', () => {
    const labelKey = 'settings.openchamber.visual.option.largeTextPaste.inlineDoublePaste.label';
    const hintKey = 'settings.openchamber.visual.field.largeTextPasteHint';
    expect(enDict[labelKey]).toBe('Paste inline, double-paste to attach');
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary[labelKey]).toBeTruthy();
      if (locale !== 'en') {
        expect(dictionary[labelKey]).not.toBe(enDict[labelKey]);
        expect(dictionary[hintKey]).not.toBe(enDict[hintKey]);
      }
    }
  });
  test('all locales stay in key parity with english', () => {
    const englishKeys = Object.keys(enDict).sort();

    for (const dictionary of Object.values(localeDictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
    }
  });

  test('all locales stay in placeholder parity with english', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

    const mismatches: string[] = [];
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      for (const [key, englishText] of Object.entries(enDict)) {
        const localeText = dictionary[key as keyof typeof dictionary];
        if (typeof localeText !== 'string' || typeof englishText !== 'string') continue;
        if (placeholders(localeText).join(',') !== placeholders(englishText).join(',')) {
          mismatches.push(locale + ' ' + key);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  test('session recovery controls are translated in every locale', () => {
    const english = Object.entries(sessionErrorRecoveryI18n.en);
    for (const [locale, dictionary] of Object.entries(sessionErrorRecoveryI18n)) {
      expect(Object.keys(dictionary).sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary[key as keyof typeof dictionary].trim()).toBeTruthy();
        if (locale !== 'en') expect(dictionary[key as keyof typeof dictionary]).not.toBe(englishText);
      }
    }
  });

  test('all locales expose language label keys', () => {
    for (const [, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary['common.language.german']).toBeTruthy();
      expect(dictionary['common.language.dutch']).toBeTruthy();
      expect(dictionary['common.language.french']).toBeTruthy();
      expect(dictionary['common.language.japanese']).toBeTruthy();
      expect(dictionary['common.language.arabic']).toBeTruthy();
      expect(dictionary['common.language.hebrew']).toBeTruthy();
    }
  });

  test('telemetry translations retain the numeric token placeholders', () => {
    for (const dictionary of Object.values(localeDictionaries)) {
      expect(dictionary['chat.workStatus.telemetry.tokens.inOut']).toContain('{input}');
      expect(dictionary['chat.workStatus.telemetry.tokens.inOut']).toContain('{output}');
      for (const parameter of ['input', 'output', 'reasoning']) {
        expect(dictionary['chat.workStatus.telemetry.tokensDescription']).toContain(`{${parameter}}`);
      }
    }
  });

  // Issue #299: 222 routing strings shipped in English in the ar and he blocks.
  test('routing strings are translated in Arabic and Hebrew and keep their placeholders', () => {
    const english = new Map<string, string>(Object.entries(routingI18n.en));
    expect(english.size > 300).toBe(true);
    const placeholders = (text: string | undefined) => (text?.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    for (const locale of ['ar', 'he'] as const) {
      const translated = new Map<string, string>(Object.entries(routingI18n[locale]));
      expect([...translated.keys()].sort()).toEqual([...english.keys()].sort());
      const untranslated = [...english].filter(([key, text]) => translated.get(key) === text).map(([key]) => key);
      expect(untranslated).toEqual([]);
      for (const [key, text] of english) {
        expect(placeholders(translated.get(key))).toEqual(placeholders(text));
      }
    }
  });

  test('routing telemetry target column is translated in every locale', () => {
    const key = 'settings.pools.telemetry.target';
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      if (locale !== 'en') expect(dictionary[key]).not.toBe(enDict[key]);
    }
  });

  test('all telemetry rows have translated explanations and compact labels', () => {
    const metrics = ['responseSpeed', 'speed', 'llmDuration', 'toolDuration', 'ttft', 'steps', 'tokens', 'cacheHit', 'cost'] as const;
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      for (const metric of metrics) {
        const label = dictionary[`chat.workStatus.telemetry.${metric}`];
        const description = dictionary[`chat.workStatus.telemetry.${metric}Description`];
        expect(label.length <= 16).toBe(true);
        expect(description.length > 30).toBe(true);
        if (locale !== 'en') expect(description === enDict[`chat.workStatus.telemetry.${metric}Description`]).toBe(false);
      }
    }
  });
});
