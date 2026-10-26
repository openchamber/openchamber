import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { findMatchRanges, findPreviewRanges } from './markdownPreviewFind';

test('case-insensitive matches keep original offsets around expanding lowercase characters', () => {
  expect(findMatchRanges('alpha İ', 'ALPHA')).toEqual([{ start: 0, end: 5 }]);
  expect(findMatchRanges('İ alpha ALPHA', 'alpha')).toEqual([{ start: 2, end: 7 }, { start: 8, end: 13 }]);
  expect(findMatchRanges('alpha İ ALPHA', 'alpha')).toEqual([{ start: 0, end: 5 }, { start: 8, end: 13 }]);
  expect(findMatchRanges('İİ', 'i')).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  expect(findMatchRanges('İİ', 'i\u0307')).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  expect(findMatchRanges('İİİ', 'İİ')).toEqual([{ start: 0, end: 2 }]);
  expect(findMatchRanges('İ ΟΣ', 'ος')).toEqual([{ start: 2, end: 4 }]);
  expect(findMatchRanges('İ 😀 ALPHA', 'alpha')).toEqual([{ start: 5, end: 10 }]);
});

test('preview ranges select original text before, across and after lowercase expansion', () => {
  const dom = new Window();
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.assign(globalThis, { document: dom.document });
  const container = document.createElement('div');
  container.textContent = 'alpha İ ALPHA';
  const text = container.firstChild;
  try {
    const ranges = findPreviewRanges(container, 'alpha');
    expect(ranges.map((range) => [range.startOffset, range.endOffset, range.toString()])).toEqual([
      [0, 5, 'alpha'], [8, 13, 'ALPHA'],
    ]);
    expect(findPreviewRanges(container, 'İ alpha').map((range) => range.toString())).toEqual(['İ ALPHA']);
    expect(findPreviewRanges(container, 'i').map((range) => [range.startOffset, range.endOffset, range.toString()])).toEqual([[6, 7, 'İ']]);
    expect(container.firstChild).toBe(text);
  } finally {
    dom.happyDOM.cancelAsync();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
