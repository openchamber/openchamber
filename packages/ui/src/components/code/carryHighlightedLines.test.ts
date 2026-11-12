import { describe, expect, test } from 'bun:test';
import { carryUnchangedLines } from './carryHighlightedLines';

const ready = (code: string, language = 'ts') => ({ code, language, lines: code.split('\n').map((line) => `<b>${line}</b>`) });

describe('carryUnchangedLines', () => {
  test('keeps the colours of lines that did not change while new ones tokenize', () => {
    expect(carryUnchangedLines(ready('const a = 1;\nconst b = 2;'), 'const a = 1;\nconst b = 3;\nconst c = 4;', 'ts'))
      .toEqual(['<b>const a = 1;</b>', undefined, undefined]);
  });

  test('carries every line of a block that only grew', () => {
    expect(carryUnchangedLines(ready('one\ntwo'), 'one\ntwo\nthree', 'ts')).toEqual(['<b>one</b>', '<b>two</b>', undefined]);
  });

  test('carries nothing across a language change or without a previous result', () => {
    expect(carryUnchangedLines(ready('one'), 'one', 'py')).toEqual([]);
    expect(carryUnchangedLines(null, 'one', 'ts')).toEqual([]);
  });
});
