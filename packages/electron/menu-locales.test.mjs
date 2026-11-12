import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_MENU_LABEL_DICTIONARIES,
  MENU_LOCALE_DICTIONARIES,
  createContextMenuLabels,
  menuLabel,
  normalizeMenuLocale,
  roleMenuItem,
} from './menu-locales.mjs';

test('menuLabel returns proper English labels for en and other locales', () => {
  assert.equal(menuLabel('en', 'file'), 'File');
  assert.equal(menuLabel('en', 'settings'), 'Settings');
  assert.equal(menuLabel('en', 'app.name'), 'OpenChamber');
  assert.equal(menuLabel(undefined, 'file'), 'File');
  assert.equal(menuLabel('xx', 'file'), 'File');
  assert.equal(menuLabel('fr', 'file'), 'Fichier');
  assert.equal(menuLabel('zh-CN', 'file'), '文件');
  assert.equal(menuLabel('zh-TW', 'file'), '檔案');
});

test('menuLabel falls back to the raw key for unknown keys', () => {
  assert.equal(menuLabel('zh-CN', 'not.a.real.key'), 'not.a.real.key');
  assert.equal(menuLabel('en', 'not.a.real.key'), 'not.a.real.key');
});

test('normalizeMenuLocale keeps translated locales and defaults everything else to en', () => {
  assert.equal(normalizeMenuLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeMenuLocale('zh-TW'), 'zh-TW');
  assert.equal(normalizeMenuLocale('en'), 'en');
  assert.equal(normalizeMenuLocale('de'), 'de');
  assert.equal(normalizeMenuLocale('uk'), 'uk');
  assert.equal(normalizeMenuLocale('pt-BR'), 'pt-BR');
  assert.equal(normalizeMenuLocale('xx'), 'en');
  assert.equal(normalizeMenuLocale(undefined), 'en');
});

test('menu dictionaries share identical key sets across locales', () => {
  const enKeys = Object.keys(MENU_LOCALE_DICTIONARIES.en).sort();
  for (const locale of Object.keys(MENU_LOCALE_DICTIONARIES)) {
    const keys = Object.keys(MENU_LOCALE_DICTIONARIES[locale]).sort();
    assert.deepEqual(keys, enKeys, `menu dictionary ${locale} key mismatch`);
  }

  const enContextKeys = Object.keys(CONTEXT_MENU_LABEL_DICTIONARIES.en).sort();
  for (const locale of Object.keys(CONTEXT_MENU_LABEL_DICTIONARIES)) {
    const keys = Object.keys(CONTEXT_MENU_LABEL_DICTIONARIES[locale]).sort();
    assert.deepEqual(keys, enContextKeys, `context menu dictionary ${locale} key mismatch`);
  }
});

test('createContextMenuLabels starts in English and applies locale dictionaries', () => {
  const { labels, apply } = createContextMenuLabels();
  assert.equal(labels.copy, '&Copy');
  assert.equal(labels.selectAll, 'Select &All');

  apply('zh-CN');
  assert.equal(labels.copy, '复制');
  assert.equal(labels.selectAll, '全选');
  assert.equal(labels.searchWithGoogle, '使用 Google 搜索“{selection}”');

  apply('zh-TW');
  assert.equal(labels.copy, '複製');
  assert.equal(labels.selectAll, '全選');

  apply('de');
  assert.equal(labels.copy, 'Kopieren');

  apply('xx');
  assert.equal(labels.copy, '&Copy');
  assert.equal(labels.selectAll, 'Select &All');

  apply('en');
  assert.equal(labels.copy, '&Copy');
});

test('roleMenuItem keeps Electron role labels in English and translates other locales', () => {
  assert.deepEqual(roleMenuItem('en', 'quit', 'quit'), { role: 'quit' });
  assert.deepEqual(roleMenuItem('xx', 'hide', 'hide'), { role: 'hide' });
  assert.deepEqual(roleMenuItem('uk', 'quit', 'quit'), { role: 'quit', label: menuLabel('uk', 'quit') });
  assert.deepEqual(roleMenuItem('zh-CN', 'quit', 'quit'), { role: 'quit', label: menuLabel('zh-CN', 'quit') });
});
