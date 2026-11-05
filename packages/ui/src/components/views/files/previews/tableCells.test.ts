import { describe, expect, test } from 'bun:test';

import { cellParts, sortedRowOrder } from './tableCells';

describe('sorting', () => {
  const rows = [['10'], ['9'], [''], ['apple'], ['12.5%'], ['Banana'], ['1,000']];

  test('numbers by value, then text, empty last', () => {
    expect(sortedRowOrder(rows, 0, 'ascending', 0)).toEqual([1, 0, 4, 6, 3, 5, 2]);
  });

  test('reversed, with empty cells still last and pinned rows on top', () => {
    expect(sortedRowOrder(rows, 0, 'descending', 1)).toEqual([0, 5, 3, 6, 4, 1, 2]);
  });

  test('equal values keep their order', () => {
    expect(sortedRowOrder([['a', '1'], ['a', '2'], ['A', '3']], 0, 'ascending', 0)).toEqual([0, 1, 2]);
  });
});

describe('links in cells', () => {
  test('finds addresses inside text and leaves the punctuation out', () => {
    expect(cellParts('see https://a.dev/x, or www.b.dev.')).toEqual([
      { text: 'see ' }, { text: 'https://a.dev/x', href: 'https://a.dev/x' }, { text: ', or ' }, { text: 'www.b.dev', href: 'https://www.b.dev' }, { text: '.' },
    ]);
  });

  test('a link the file sets covers the cell, and only a safe one counts', () => {
    expect(cellParts('Report', 'https://a.dev')).toEqual([{ text: 'Report', href: 'https://a.dev' }]);
    expect(cellParts('Report', 'javascript:alert(1)')).toEqual([{ text: 'Report' }]);
    expect(cellParts('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }]);
  });
});
