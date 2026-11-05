import { describe, expect, test } from 'bun:test';

import { delimiterForPath, parseDelimitedText, setDelimitedField } from './delimitedText';

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

describe('setDelimitedField', () => {
  test('replaces one field and keeps every other byte', () => {
    const file = '﻿a,"b, q"\r\n1,"x ""y"""\r\n\r\n3,4';
    expect(setDelimitedField(file, ',', 1, 0, '9')).toBe('﻿a,"b, q"\r\n9,"x ""y"""\r\n\r\n3,4');
    expect(setDelimitedField(file, ',', 1, 1, 'z')).toBe('﻿a,"b, q"\r\n1,z\r\n\r\n3,4');
    expect(setDelimitedField(file, ',', 2, 1, '5')).toBe('﻿a,"b, q"\r\n1,"x ""y"""\r\n\r\n3,5');
  });

  test('quotes what needs it', () => {
    expect(setDelimitedField('a,b\n', ',', 0, 1, 'x,"y"')).toBe('a,"x,""y"""\n');
  });

  test('adds a missing column and a new row', () => {
    expect(setDelimitedField('a,b\n1\n', ',', 1, 2, 'c')).toBe('a,b\n1,,c\n');
    expect(setDelimitedField('a,b\n1,2\n', ',', 2, 1, 'n')).toBe('a,b\n1,2\n,n\n');
    expect(setDelimitedField('a\tb', '\t', 1, 0, 'n')).toBe('a\tb\nn\n');
  });

  test('reads back through the parser', () => {
    const edited = setDelimitedField('name,note\nAda,"line one\nline two"\n', ',', 1, 1, 'new\nvalue');
    expect(parseDelimitedText(edited, ',').rows).toEqual([['Ada', 'new\nvalue']]);
  });
});
