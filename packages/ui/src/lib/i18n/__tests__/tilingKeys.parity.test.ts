import { describe, expect, test } from 'bun:test';

import { dict as en } from '../messages/en';
import { dict as es } from '../messages/es';
import { dict as fr } from '../messages/fr';
import { dict as ja } from '../messages/ja';
import { dict as ko } from '../messages/ko';
import { dict as pl } from '../messages/pl';
import { dict as ptBR } from '../messages/pt-BR';
import { dict as uk } from '../messages/uk';
import { dict as zhCN } from '../messages/zh-CN';
import { dict as zhTW } from '../messages/zh-TW';
import { LOCALES, type Locale } from '../runtime';

// Tiling / Tiled Side Panel message keys, derived from the `t('...')` call sites in
// packages/ui/src/components/layout/tiling/. Every locale must define each of these
// (missing = MessageKey type error and/or runtime fallback gap).
const TILING_KEYS = [
  'tiling.splitAnchor.left',
  'tiling.splitAnchor.right',
  'tiling.splitAnchor.top',
  'tiling.splitAnchor.bottom',
  'tiling.region.moveTarget',
  'contextPanel.region.aria',
] as const;

const DICTS: Record<Locale, Record<string, string>> = {
  en,
  es,
  fr,
  ja,
  ko,
  pl,
  uk,
  'pt-BR': ptBR,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

describe('tiling i18n key parity', () => {
  test('every locale is present in the dictionary map', () => {
    for (const locale of LOCALES) {
      expect(Boolean(DICTS[locale])).toBe(true);
    }
  });

  test('every locale defines every tiling key, non-empty', () => {
    for (const locale of LOCALES) {
      const dictionary = DICTS[locale];
      for (const key of TILING_KEYS) {
        const value = dictionary[key];
        expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
      }
    }
  });
});
