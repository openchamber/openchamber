import { expect, test } from 'bun:test';
import * as highlights from '@pierre/highlights';

import { LANGUAGE_RELATIVES } from '@/lib/shiki/languageRelatives';
import { highlightsLanguage, highlightsLineHtml, highlightsNow, loadHighlights, stripAnsi } from './highlightsEngine';

// Plain text takes the foreground color.
const PLAIN = '<span style="color:var(--md-foreground, var(--md-syntax-foreground))">';

test('a language without a lexer takes its relative, an unknown one is plain text', () => {
  expect(highlightsLanguage(highlights, 'typescript')).toBe('typescript');
  expect(highlightsLanguage(highlights, 'purescript')).toBe('haskell');
  expect(highlightsLanguage(highlights, 'console')).toBe('bash');
  expect(highlightsLanguage(highlights, 'glimmer-ts')).toBe('typescript');
  expect(highlightsLanguage(highlights, 'no-such-language')).toBe('text');
  expect(highlightsLanguage(highlights, 'ansi')).toBe('text');
});

test('a lexer of its own wins over the relative', () => {
  expect(highlights.isSupportedLanguage('ini')).toBe(true);
  expect(highlightsLanguage(highlights, 'ini')).toBe('ini');
});

test('every relative has a lexer', () => {
  for (const relative of LANGUAGE_RELATIVES.values()) expect([relative, highlights.isSupportedLanguage(relative)]).toEqual([relative, true]);
});

test('ANSI escapes are stripped and the text around them kept', () => {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  expect(stripAnsi(`${esc}[1;31mred${esc}[0m plain\nnext ${esc}[38;5;82mgreen${esc}[m`)).toBe('red plain\nnext green');
  expect(stripAnsi(`${esc}[2K${esc}[1Gprogress`)).toBe('progress');
  expect(stripAnsi(`${esc}]8;;https://example.com${bel}link${esc}]8;;${esc}\\ end`)).toBe('link end');
  expect(stripAnsi('array[0] = "[31m";')).toBe('array[0] = "[31m";');
});

test('an ANSI block renders as uncolored text without its escapes', async () => {
  await loadHighlights();
  const esc = String.fromCharCode(27);
  const input = highlightsNow('ansi', `${esc}[31m<a>${esc}[0m b\nconst c = 1;`);
  expect(input && highlightsLineHtml(input)).toEqual([`${PLAIN}&lt;a&gt; b</span>`, `${PLAIN}const c = 1;</span>`]);
});

test('a relative colors the code', async () => {
  await loadHighlights();
  const input = highlightsNow('purescript', '-- note');
  expect(input && highlightsLineHtml(input)).toEqual(['<span style="color:var(--md-syntax-comment)">-- note</span>']);
});
