import { describe, expect, test } from 'bun:test';

import { delimiterForPath, parseDelimitedText } from './delimitedText';

describe('parseDelimitedText', () => {
  test('splits a plain CSV into a header and rows, ignoring the trailing newline', () => {
    const table = parseDelimitedText('name,age\nAda,36\nLinus,54\n', ',');
    expect(table.header).toEqual(['name', 'age']);
    expect(table.rows).toEqual([['Ada', '36'], ['Linus', '54']]);
    expect(table.totalRows).toBe(2);
    expect(table.columnCount).toBe(2);
    expect(table.truncated).toBe(false);
  });

  test('keeps delimiters, newlines and doubled quotes inside quoted fields', () => {
    const table = parseDelimitedText('id,note\r\n1,"a, b"\r\n2,"line one\nline two"\r\n3,"say ""hi"""\r\n', ',');
    expect(table.rows).toEqual([['1', 'a, b'], ['2', 'line one\nline two'], ['3', 'say "hi"']]);
  });

  test('reads TSV by path and a UTF-8 BOM does not leak into the first header', () => {
    expect(delimiterForPath('/x/data.tsv')).toBe('\t');
    expect(delimiterForPath('/x/data.CSV')).toBe(',');
    const table = parseDelimitedText('﻿a\tb\n1\t2\n', '\t');
    expect(table.header).toEqual(['a', 'b']);
    expect(table.rows).toEqual([['1', '2']]);
  });

  test('counts every row but keeps only the capped ones', () => {
    const lines = ['n', ...Array.from({ length: 10 }, (_, index) => String(index))];
    const table = parseDelimitedText(lines.join('\n'), ',', 4);
    expect(table.rows).toHaveLength(4);
    expect(table.totalRows).toBe(10);
    expect(table.truncated).toBe(true);
  });

  test('a ragged file reports the widest row and an empty file has no columns', () => {
    expect(parseDelimitedText('a,b\n1,2,3\n', ',').columnCount).toBe(3);
    expect(parseDelimitedText('', ',')).toEqual({ header: [], rows: [], totalRows: 0, columnCount: 0, truncated: false });
  });
});
