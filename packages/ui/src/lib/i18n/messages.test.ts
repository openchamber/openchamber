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
  test('Zen labels are translated and preserve their value placeholders in every locale', () => {
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary['quota.value.requests']).toContain('{count}');
      expect(dictionary['quota.value.spent']).toContain('{spent}');
      expect(dictionary['quota.family.zen']).toContain('Zen');
      if (locale !== 'en') {
        for (const key of ['quota.value.requests', 'quota.value.spent', 'quota.family.zen'] as const) {
          expect(dictionary[key]).not.toBe(enDict[key]);
        }
      }
    }
  });

  test('credits-used messages carry the amount and are translated in every locale', () => {
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary['quota.value.creditsUsed']).toContain('{credits}');
      if (locale !== 'en') {
        expect(dictionary['quota.value.creditsUsed']).not.toBe(enDict['quota.value.creditsUsed']);
      }
    }
  });
  test('repository links name either provider in every locale', () => {
    for (const dictionary of Object.values(localeDictionaries)) {
      expect(dictionary['gitView.header.openRepository']).toContain('{provider}');
    }
  });

  // A review host's change carries the same provider-neutral wording as a pull
  // or merge request: each `change` member names its host through `{provider}`.
  test('change families name their provider in every locale', () => {
    const changeKeys = [
      'settings.sourceControl.provider.description.change',
      'references.picker.empty.notConnected.change',
      'chat.chatInput.actions.linkRepositoryItem.change',
      'session.newWorktree.actions.startFromRepository.change',
      'sourceBoard.list.repository.change',
      'gitView.change.actions.openOnProviderAria',
      'settings.sourceControl.field.username.info',
      'settings.sourceControl.field.httpPassword.info',
      'settings.sourceControl.field.httpPassword.rejected',
    ] as const;
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      for (const key of changeKeys) {
        expect(`${locale} ${key}: ${dictionary[key].includes('{provider}')}`).toBe(`${locale} ${key}: true`);
        expect(`${locale} ${key}: ${/GitHub|GitLab|Gerrit|Linear/.test(dictionary[key])}`).toBe(`${locale} ${key}: false`);
      }
    }
  });
  // A sentence that names its provider through `{provider}` serves every
  // provider; a literal product name would put GitHub's words on Gitea's card.
  test('provider sentences keep {provider} and name no product in every locale', () => {
    const english: Record<string, string> = enDict;
    const providerKeys = Object.keys(english).filter((key) => english[key].includes('{provider}'));
    expect(providerKeys.length).toBeGreaterThan(0);
    expect(providerKeys).toContain('sourceBoard.list.repository.change');
    expect(providerKeys).toContain('chat.chatInput.actions.linkRepositoryItem.change');
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      const translated: Record<string, string> = dictionary;
      for (const key of providerKeys) {
        const text = translated[key] ?? '';
        expect(`${locale} ${key}: ${text.includes('{provider}')}`).toBe(`${locale} ${key}: true`);
        expect(`${locale} ${key}: ${/GitHub|GitLab|Linear/.test(text)}`).toBe(`${locale} ${key}: false`);
      }
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
