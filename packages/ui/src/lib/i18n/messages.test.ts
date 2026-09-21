import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './messages/en';
import { dict as esDict } from './messages/es';
import { dict as deDict } from './messages/de';
import { dict as frDict } from './messages/fr';
import { dict as jaDict } from './messages/ja';
import { dict as koDict } from './messages/ko';
import { dict as plDict } from './messages/pl';
import { dict as ptBrDict } from './messages/pt-BR';
import { dict as ukDict } from './messages/uk';
import { dict as zhCnDict } from './messages/zh-CN';
import { dict as zhTwDict } from './messages/zh-TW';
import { dict as trDict } from './messages/tr';

const localeDictionaries = {
  en: enDict,
  de: deDict,
  fr: frDict,
  es: esDict,
  ja: jaDict,
  'pt-BR': ptBrDict,
  uk: ukDict,
  ko: koDict,
  pl: plDict,
  'zh-CN': zhCnDict,
  'zh-TW': zhTwDict,
  tr: trDict,
} as const;

describe('i18n dictionaries', () => {
  test('all locales stay in key parity with english', () => {
    const englishKeys = Object.keys(enDict).sort();

    for (const dictionary of Object.values(localeDictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
    }
  });

  test('all locales expose language label keys', () => {
    for (const [, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary['common.language.german']).toBeTruthy();
      expect(dictionary['common.language.french']).toBeTruthy();
      expect(dictionary['common.language.japanese']).toBeTruthy();
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
