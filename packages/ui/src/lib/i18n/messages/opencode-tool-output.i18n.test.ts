import { describe, expect, test } from 'bun:test';

import { OPENCODE_TOOL_VERB_KEYS } from '@/components/chat/message/parts/opencodeToolResult';
import { opencodeToolOutputI18n } from './opencode-tool-output.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('OpenCode tool output translations', () => {
  test('every locale has every key, filled, with the same placeholders', () => {
    const english: Record<string, string> = opencodeToolOutputI18n.en;
    const keys = Object.keys(english).sort();
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
    for (const locale of locales) {
      const dictionary: Record<string, string> = opencodeToolOutputI18n[locale];
      expect(Object.keys(dictionary).sort()).toEqual(keys);
      for (const key of keys) {
        expect(dictionary[key]?.trim()).toBeTruthy();
        expect(placeholders(dictionary[key] ?? '')).toEqual(placeholders(english[key] ?? ''));
      }
    }
  });

  test('every tool verb has a key', () => {
    for (const key of Object.values(OPENCODE_TOOL_VERB_KEYS)) {
      expect(key in opencodeToolOutputI18n.en).toBe(true);
    }
  });
});
