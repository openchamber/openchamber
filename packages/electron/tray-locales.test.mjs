import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRAY_LOCALE_DICTIONARIES,
  formatTrayLabel,
  normalizeTrayLocale,
  trayLabel,
} from './tray-locales.mjs';

test('trayLabel returns proper labels per locale and falls back to English', () => {
  assert.equal(trayLabel('en', 'sessions'), 'Sessions');
  assert.equal(trayLabel(undefined, 'sessions'), 'Sessions');
  assert.equal(trayLabel('xx', 'sessions'), 'Sessions');
  assert.equal(trayLabel('zh-CN', 'sessions'), '会话');
  assert.equal(trayLabel('zh-TW', 'sessions'), '對話');
  assert.equal(trayLabel('de', 'close'), 'Schließen');
  assert.equal(trayLabel('ja', 'deny'), '拒否');
});

test('trayLabel falls back to the raw key for unknown keys', () => {
  assert.equal(trayLabel('zh-CN', 'not.a.real.key'), 'not.a.real.key');
  assert.equal(trayLabel('en', 'not.a.real.key'), 'not.a.real.key');
});

test('normalizeTrayLocale keeps translated locales and defaults everything else to en', () => {
  assert.equal(normalizeTrayLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeTrayLocale('zh-TW'), 'zh-TW');
  assert.equal(normalizeTrayLocale('en'), 'en');
  assert.equal(normalizeTrayLocale('de'), 'de');
  assert.equal(normalizeTrayLocale('uk'), 'uk');
  assert.equal(normalizeTrayLocale('pt-BR'), 'pt-BR');
  assert.equal(normalizeTrayLocale('xx'), 'en');
  assert.equal(normalizeTrayLocale(undefined), 'en');
});

test('tray dictionary locales share identical key sets', () => {
  const enKeys = Object.keys(TRAY_LOCALE_DICTIONARIES.en).sort();
  for (const locale of Object.keys(TRAY_LOCALE_DICTIONARIES)) {
    const keys = Object.keys(TRAY_LOCALE_DICTIONARIES[locale]).sort();
    assert.deepEqual(keys, enKeys, `tray dictionary ${locale} key mismatch`);
  }
});

test('formatTrayLabel replaces {count} and leaves unknown placeholders intact', () => {
  assert.equal(formatTrayLabel('en', 'more', { count: 3 }), '3 more…');
  assert.equal(formatTrayLabel('zh-CN', 'more', { count: 2 }), '另外 2 个…');
  assert.equal(formatTrayLabel('en', 'working', { count: 1 }), '1 working');
  // No value supplied → the placeholder is preserved rather than "undefined".
  assert.equal(formatTrayLabel('en', 'more'), '{count} more…');
  assert.equal(formatTrayLabel('en', 'working', { other: 1 }), '{count} working');
});
