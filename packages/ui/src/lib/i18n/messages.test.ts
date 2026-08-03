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
} as const;

const task10Keys = [
  'chat.statusRow.retrying',
  'chat.statusRow.retryingIn',
  'chat.statusRow.retryAttempt',
  'chat.statusRow.recoveryBlocked',
  'chat.chatInput.toast.queueFull',
  'chat.chatInput.toast.queueTargetsFull',
] as const;

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

  test('all locales provide localized retry and queue-capacity messages', () => {
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      for (const key of task10Keys) {
        expect(dictionary[key]).toBeTruthy();
        if (locale !== 'en') {
          expect(dictionary[key]).not.toBe(enDict[key]);
        }
      }
    }
  });
});
