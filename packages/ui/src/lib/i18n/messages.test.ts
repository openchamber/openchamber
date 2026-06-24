import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './messages/en';
import { dict as esDict } from './messages/es';
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

describe('i18n dictionaries', () => {
  test('french stays in key parity with english', () => {
    const englishKeys = Object.keys(enDict).sort();

    expect(Object.keys(frDict).sort()).toEqual(englishKeys);
  });

  test('all locales expose the french language label key', () => {
    for (const [, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary['common.language.french']).toBeTruthy();
    }
  });
});
