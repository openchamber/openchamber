import { expect, test } from 'bun:test';
import { getFiletypeFromFileName } from '@pierre/diffs';
import { isSupportedLanguage } from '@pierre/highlights';

import { DIFFS_HIGHLIGHTER, toDiffsLanguage } from './diffsHighlighter';

test('runs Highlights where WebAssembly with SIMD is available', () => {
  expect(DIFFS_HIGHLIGHTER).toBe('highlights');
});

test('files Highlights has no lexer for take a close relative', () => {
  for (const [name, lang] of [
    ['views/page.html.erb', 'html'],
    ['templates/card.hbs', 'html'],
    ['.env', 'bash'],
    ['setup.cfg', 'toml'],
    ['app.properties', 'toml'],
    ['.editorconfig', 'toml'],
    ['src/main.ts', 'typescript'],
  ]) {
    expect(getFiletypeFromFileName(name)).toBe(lang);
    expect(isSupportedLanguage(lang)).toBe(true);
  }
  expect(toDiffsLanguage('ini')).toBe('toml');
  expect(toDiffsLanguage('typescript')).toBe('typescript');
  expect(toDiffsLanguage(null)).toBeUndefined();
});
