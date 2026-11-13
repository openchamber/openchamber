import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import { dict as en } from '@/lib/i18n/messages/en';

/**
 * Every message key the tracker card and its extension-account neighbours name
 * exists in the English dictionary. The dictionaries' own test checks parity
 * between locales; this one checks the reference, so a key renamed in the
 * code or the catalog cannot leave the card showing a raw key.
 */
const FILES = [
  'TrackerSettings.tsx',
  'TrackerProjectMapping.tsx',
  'TrackerSessionComments.tsx',
  'GuestIntegrationsSection.tsx',
  'trackerSettingsCopy.ts',
  '../extensions/GuestApprovalDialog.tsx',
];

const KEY = /'((?:settings|common)\.[A-Za-z0-9.]+)'/g;

describe('tracker settings message keys', () => {
  test('every key the card names exists in the English dictionary', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of FILES) {
      const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      for (const match of source.matchAll(KEY)) {
        const key = match[1];
        seen += 1;
        if (!(key in en)) missing.push(`${file}: ${key}`);
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});
