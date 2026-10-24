import { describe, expect, test } from 'bun:test';

import {
  countDelimitedColumnCells,
  cutDelimitedRow,
  delimiterForPath,
  parseDelimitedText,
} from './delimitedText';
import {
  characterWidthsFrom,
  displayCells,
  measureTableColumns,
  type TableCellMetrics,
  type TableCharacterWidths,
  type TableColumnWidths,
} from './tableLayout';

const QUOTE_CODE = 34;
const LINE_FEED_CODE = 10;
const CARRIAGE_RETURN_CODE = 13;

/**
 * The table as the parser handed it over before the rows were kept as places
 * in the text.
 */
type ReferenceTable = {
  header: string[];
  rows: string[][];
  totalRows: number;
  columnCount: number;
  truncated: boolean;
};

/**
 * The parser as it was before the rows were kept as places in the text.
 *
 * It is the oracle the new parser is held to: the fuzz test below runs both
 * over thousands of files and asks for the same result from both. It stays in
 * this file so the behaviour that was there is visible and checked on every
 * run, and not only in the history of the repository.
 */
const referenceParseDelimitedText = (
  content: string,
  delimiter: ',' | '\t',
  rowCap: number = 2_000,
): ReferenceTable => {
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const length = source.length;
  const delimiterCode = delimiter.charCodeAt(0);

  // The records the preview holds: the header and the rows under the cap.
  const records: string[][] = [];
  let totalRecords = 0;

  let record: string[] = [];
  let field = '';
  /** Whether the field being read has no characters in it yet. */
  let fieldIsEmpty = true;
  /** How many fields the record being read has, the last one still open. */
  let fieldsInRecord = 0;
  /** Whether the record holds a quote or a delimiter, which is what tells a
   * record apart from a blank line. */
  let recordHasContent = false;
  let quoted = false;
  /** A record past the cap is counted but not held. */
  let collecting = true;

  let position = 0;

  while (position < length) {
    if (quoted) {
      // Inside a quoted field only the closing quote is special.
      let at = position;
      while (at < length && source.charCodeAt(at) !== QUOTE_CODE) at += 1;
      if (at > position) {
        if (collecting) {
          const text = source.slice(position, at);
          field = fieldIsEmpty ? text : field + text;
        }
        fieldIsEmpty = false;
      }
      if (at >= length) {
        // The file ends inside the quoted field, so the rest is its content.
        position = length;
        break;
      }
      if (source.charCodeAt(at + 1) === QUOTE_CODE) {
        // A doubled quote inside a quoted field is one literal quote.
        if (collecting) field = fieldIsEmpty ? '"' : field + '"';
        fieldIsEmpty = false;
        position = at + 2;
        continue;
      }
      quoted = false;
      position = at + 1;
      continue;
    }

    // The field runs up to the next delimiter, quote or line break.
    let at = position;
    while (at < length) {
      const code = source.charCodeAt(at);
      if (code === delimiterCode || code === QUOTE_CODE || code === LINE_FEED_CODE || code === CARRIAGE_RETURN_CODE) {
        break;
      }
      at += 1;
    }
    if (at > position) {
      if (collecting) {
        const text = source.slice(position, at);
        field = fieldIsEmpty ? text : field + text;
      }
      fieldIsEmpty = false;
    }
    if (at >= length) {
      // The rest of the file is the last field.
      position = length;
      break;
    }

    const code = source.charCodeAt(at);
    if (code === QUOTE_CODE) {
      quoted = true;
      recordHasContent = true;
      position = at + 1;
      continue;
    }
    if (code === delimiterCode) {
      if (collecting) record.push(field);
      field = '';
      fieldIsEmpty = true;
      fieldsInRecord += 1;
      recordHasContent = true;
      position = at + 1;
      continue;
    }
    // A line break ends the record. A carriage return followed by a line feed
    // is one break.
    position = code === CARRIAGE_RETURN_CODE && source.charCodeAt(at + 1) === LINE_FEED_CODE
      ? at + 2
      : at + 1;
    const isBlank = !recordHasContent && fieldIsEmpty;
    if (collecting) record.push(field);
    field = '';
    fieldIsEmpty = true;
    // A trailing newline is not an empty record; a single empty field is only
    // a record when something else on that line said so.
    if (!isBlank) {
      if (totalRecords === 0 || records.length <= rowCap) records.push(record);
      totalRecords += 1;
    }
    record = [];
    fieldsInRecord = 0;
    recordHasContent = false;
    // The same rule the record is held by, read before the record is read:
    // the counts do not move until the record ends.
    collecting = totalRecords === 0 || records.length <= rowCap;
  }

  if (!fieldIsEmpty || fieldsInRecord > 0 || quoted) {
    const isBlank = !recordHasContent && fieldIsEmpty;
    if (collecting) record.push(field);
    if (!isBlank) {
      if (totalRecords === 0 || records.length <= rowCap) records.push(record);
      totalRecords += 1;
    }
  }

  const header = records[0] ?? [];
  const rows = records.slice(1);
  const columnCount = records.reduce((max, entry) => Math.max(max, entry.length), 0);
  const totalRows = Math.max(0, totalRecords - 1);
  return {
    header,
    rows,
    totalRows,
    columnCount,
    truncated: rows.length < totalRows,
  };
};

/**
 * The characters outside latin, found by the walk over the text of the file
 * that the parser used to make on its own.
 */
const referenceCollectNonLatinCodePoints = (content: string, limit: number): number[] => {
  const start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  const seen = new Uint8Array(0x10000);
  const above = new Set<number>();
  const codePoints: number[] = [];
  for (let index = start; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code < 0x80) continue;
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < content.length) {
      const low = content.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const point = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        if (!above.has(point)) {
          above.add(point);
          codePoints.push(point);
          if (codePoints.length >= limit) return codePoints;
        }
        index += 1;
        continue;
      }
    }
    if (seen[code]) continue;
    seen[code] = 1;
    codePoints.push(code);
    if (codePoints.length >= limit) return codePoints;
  }
  return codePoints;
};

/**
 * The width every column asked for, the way the preview found it before the
 * parser counted the values as it read them.
 */
const referenceMeasureTableColumns = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columnCount: number,
  metrics: TableCellMetrics,
  characterWidths?: TableCharacterWidths,
): TableColumnWidths => {
  const maxCells = metrics.charWidth > 0
    ? Math.max(1, Math.floor((metrics.maxCellWidth - metrics.cellPadding - metrics.cellBorder + 1 / 64) / metrics.charWidth))
    : Number.POSITIVE_INFINITY;
  let widestCharacter = 2;
  if (characterWidths) {
    for (const width of characterWidths.values()) {
      if (width > widestCharacter) widestCharacter = width;
    }
  }

  const bodyCells = new Array<number>(columnCount).fill(0);
  for (const row of rows) {
    const fields = Math.min(row.length, columnCount);
    for (let column = 0; column < fields; column += 1) {
      if (bodyCells[column] >= maxCells) continue;
      const value = row[column];
      if (value === undefined) continue;
      if (value.length * widestCharacter <= bodyCells[column]) continue;
      const width = displayCells(value, characterWidths);
      if (width > bodyCells[column]) bodyCells[column] = width;
    }
  }

  const cells = new Array<number>(columnCount).fill(0);
  let totalCells = 0;
  for (let column = 0; column < columnCount; column += 1) {
    const headerCells = displayCells(header[column] ?? '', characterWidths);
    const width = Math.max(headerCells, Math.min(bodyCells[column], maxCells));
    cells[column] = Math.ceil(width * 1000) / 1000;
    totalCells += cells[column];
  }

  return { cells, totalCells };
};

/**
 * The table in the shape the preview reads it in: the header's values and the
 * values of every kept row.
 *
 * The rows are cut out of the source again, which is what the preview does
 * with them, so the expectations below stay the ones the parser has always
 * met.
 */
const preview = (
  content: string,
  delimiter: ',' | '\t' = ',',
  rowCap?: number,
): ReferenceTable => {
  const table = parseDelimitedText(content, delimiter, rowCap);
  return {
    header: table.header,
    rows: table.rows.map((row) => cutDelimitedRow(content, row, delimiter)),
    totalRows: table.totalRows,
    columnCount: table.columnCount,
    truncated: table.truncated,
  };
};

/**
 * A file of a random shape.
 *
 * The generator draws from the awkward parts of a real export: a quoted
 * value, a delimiter or a newline inside a quoted value, a doubled quote, a
 * quote that is never closed, an empty value, a row that is shorter than the
 * one before it, line endings that differ, a blank line, a byte order mark
 * and characters outside latin.
 */
const randomFile = (seed: number, delimiter: ',' | '\t'): string => {
  let state = (seed * 2654435761) >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const choice = (count: number): number => Math.min(Math.floor(next() * count), count - 1);

  const value = (): string => {
    const kind = choice(12);
    if (kind === 0) return '';
    if (kind === 1) return `"${delimiter}"`;
    if (kind === 2) return '"a\nb"';
    if (kind === 3) return '"say ""hi"""';
    if (kind === 4) return '"';
    if (kind === 5) return '"a"b';
    if (kind === 6) return 'a"b';
    if (kind === 7) return '東京';
    if (kind === 8) return '🙂';
    if (kind === 9) return 'κόσμε';
    if (kind === 10) return 'plain';
    return `value_${choice(100)}`;
  };

  const parts: string[] = [];
  const rowCount = choice(9);
  for (let row = 0; row < rowCount; row += 1) {
    const last = row === rowCount - 1;
    const ending = last && choice(4) === 0
      ? ''
      : choice(3) === 0 ? '\r\n' : choice(2) === 0 ? '\r' : '\n';
    if (choice(9) === 0) {
      parts.push(ending);
      continue;
    }
    const cells: string[] = [];
    const cellCount = 1 + choice(5);
    for (let cell = 0; cell < cellCount; cell += 1) cells.push(value());
    parts.push(`${cells.join(delimiter)}${ending}`);
  }
  let content = parts.join('');
  if (choice(5) === 0) content = `﻿${content}`;
  if (choice(5) === 0) content = `${content}"never closed`;
  return content;
};

/** The caps the parser is asked for, one for every kind of cap. */
const CAPS = [0, 1, 2, 5, 2_000, -1, 2.5, Number.NaN];

describe('parseDelimitedText', () => {
  test('splits a plain CSV into a header and rows, ignoring the trailing newline', () => {
    const table = preview('name,age\nAda,36\nLinus,54\n');
    expect(table.header).toEqual(['name', 'age']);
    expect(table.rows).toEqual([['Ada', '36'], ['Linus', '54']]);
    expect(table.totalRows).toBe(2);
    expect(table.columnCount).toBe(2);
    expect(table.truncated).toBe(false);
  });

  test('keeps delimiters, newlines and doubled quotes inside quoted fields', () => {
    const table = preview('id,note\r\n1,"a, b"\r\n2,"line one\nline two"\r\n3,"say ""hi"""\r\n');
    expect(table.rows).toEqual([['1', 'a, b'], ['2', 'line one\nline two'], ['3', 'say "hi"']]);
  });

  test('reads TSV by path and a UTF-8 BOM does not leak into the first header', () => {
    expect(delimiterForPath('/x/data.tsv')).toBe('\t');
    expect(delimiterForPath('/x/data.CSV')).toBe(',');
    const table = preview('﻿a\tb\n1\t2\n', '\t');
    expect(table.header).toEqual(['a', 'b']);
    expect(table.rows).toEqual([['1', '2']]);
  });

  test('counts every row but keeps only the capped ones', () => {
    const lines = ['n', ...Array.from({ length: 10 }, (_, index) => String(index))];
    const table = preview(lines.join('\n'), ',', 4);
    expect(table.rows).toHaveLength(4);
    expect(table.totalRows).toBe(10);
    expect(table.truncated).toBe(true);
  });

  test('a ragged file reports the widest row and an empty file has no columns', () => {
    expect(preview('a,b\n1,2,3\n').columnCount).toBe(3);
    expect(preview('')).toEqual({ header: [], rows: [], totalRows: 0, columnCount: 0, truncated: false });
  });

  // The cases below pin the whole result of the parser, not one field of it.
  // Each one is a shape a real export has, so a change in any of them shows
  // up as a different table in every app that previews a CSV.

  describe('plain files and line endings', () => {
    test('a trailing newline does not add a row', () => {
      expect(preview('name,age\nAda,36\n')).toEqual({
        header: ['name', 'age'],
        rows: [['Ada', '36']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('the last row without a newline is still a row', () => {
      expect(preview('name,age\nAda,36')).toEqual({
        header: ['name', 'age'],
        rows: [['Ada', '36']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a carriage return and a line feed together end one row', () => {
      expect(preview('a,b\r\n1,2\r\n')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a carriage return on its own ends a row', () => {
      expect(preview('a,b\r1,2\r')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('the line endings in one file may differ', () => {
      expect(preview('a,b\r\n1,2\n3,4\r').rows).toEqual([['1', '2'], ['3', '4']]);
    });

    test('a file with one cell and no newline is a header of one column', () => {
      expect(preview('x')).toEqual({
        header: ['x'],
        rows: [],
        totalRows: 0,
        columnCount: 1,
        truncated: false,
      });
    });

    test('an empty file has no header and no columns', () => {
      expect(preview('')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });

    test('a file of nothing but newlines has no records', () => {
      expect(preview('\n\n')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });

    test('the spaces around a value are part of it', () => {
      expect(preview(' a , b \n').header).toEqual([' a ', ' b ']);
    });
  });

  describe('quoted fields', () => {
    test('a quoted field holds the delimiter', () => {
      expect(preview('id,note\n1,"a, b"\n').rows).toEqual([['1', 'a, b']]);
    });

    test('a quoted field holds a newline', () => {
      expect(preview('id,note\n1,"line one\nline two"\n').rows)
        .toEqual([['1', 'line one\nline two']]);
    });

    test('a doubled quote inside a quoted field is one quote', () => {
      expect(preview('id,note\n1,"say ""hi"""\n').rows).toEqual([['1', 'say "hi"']]);
    });

    test('a quoted field may be empty', () => {
      expect(preview('a,"",b\n').header).toEqual(['a', '', 'b']);
    });

    test('a quoted field that is the whole file holds one empty cell', () => {
      expect(preview('""')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });

    test('a lone quote is a record with one empty cell', () => {
      expect(preview('"')).toEqual({
        header: [''],
        rows: [],
        totalRows: 0,
        columnCount: 1,
        truncated: false,
      });
    });

    test('three quotes are one cell holding a quote', () => {
      expect(preview('"""').header).toEqual(['"']);
    });

    test('the quotes around a value are dropped', () => {
      expect(preview('"a","b"\n').header).toEqual(['a', 'b']);
    });

    test('text after a closing quote joins the same cell', () => {
      expect(preview('"a"b\n').header).toEqual(['ab']);
    });

    test('a quote that is never closed runs to the end of the file', () => {
      expect(preview('a,"b').header).toEqual(['a', 'b']);
      expect(preview('a,"b\nc').header).toEqual(['a', 'b\nc']);
    });

    test('a quote in the middle of an unquoted field is dropped and the field runs on', () => {
      expect(preview('a"b,c').header).toEqual(['ab,c']);
      expect(preview('a"b,c\n').header).toEqual(['ab,c\n']);
      expect(preview('ab"cd,ef').header).toEqual(['abcd,ef']);
    });

    test('a quoted field with a newline is followed by the cells after it', () => {
      expect(preview('a,"b\nc",d\n').header).toEqual(['a', 'b\nc', 'd']);
    });
  });

  describe('the byte order mark', () => {
    test('a byte order mark does not reach the first header', () => {
      expect(preview('﻿a,b\n1,2\n')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a byte order mark before carriage return line feeds is dropped as well', () => {
      expect(preview('﻿a,b\r\n1,2\r\n').header).toEqual(['a', 'b']);
    });

    test('a file that is only a byte order mark is empty', () => {
      expect(preview('﻿')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });
  });

  describe('the shape of the file', () => {
    test('a ragged file reports the widest record it holds', () => {
      expect(preview('a,b\n1,2,3\n')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2', '3']],
        totalRows: 1,
        columnCount: 3,
        truncated: false,
      });
    });

    test('a record may be shorter than the header', () => {
      expect(preview('a,b,c\n1,2\n')).toEqual({
        header: ['a', 'b', 'c'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 3,
        truncated: false,
      });
    });

    test('an empty field between two delimiters is a cell', () => {
      expect(preview('a,,b\n').header).toEqual(['a', '', 'b']);
    });

    test('a trailing delimiter is a trailing empty cell', () => {
      expect(preview('a,b,\n').header).toEqual(['a', 'b', '']);
      expect(preview('a,\n').header).toEqual(['a', '']);
    });

    test('a file of nothing but delimiters holds empty cells', () => {
      expect(preview(',,\n').header).toEqual(['', '', '']);
      expect(preview(',,').header).toEqual(['', '', '']);
    });

    test('a blank line between two records is not a record', () => {
      expect(preview('a,b\n\n1,2\n')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a blank line before or after the records is not a record either', () => {
      expect(preview('\na,b\n').header).toEqual(['a', 'b']);
      expect(preview('a,b\n\n').header).toEqual(['a', 'b']);
      expect(preview('\n\n\n')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });
  });

  describe('tab separated files', () => {
    test('a tab separates the cells', () => {
      expect(preview('a\tb\n1\t2\n', '\t')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a quoted field holds a tab', () => {
      expect(preview('a\tb\n1\t"x\ty"\n', '\t').rows).toEqual([['1', 'x\ty']]);
    });

    test('a blank line between the records is not a record', () => {
      expect(preview('a\tb\n\n1\t2\n', '\t').rows).toEqual([['1', '2']]);
    });
  });

  describe('the row cap', () => {
    const fiveRows = 'h\n1\n2\n3\n4\n5\n';

    test('the cap counts the rows under the header', () => {
      expect(preview(fiveRows, ',', 2)).toEqual({
        header: ['h'],
        rows: [['1'], ['2']],
        totalRows: 5,
        columnCount: 1,
        truncated: true,
      });
    });

    test('the header is kept even when the cap is zero', () => {
      expect(preview(fiveRows, ',', 0)).toEqual({
        header: ['h'],
        rows: [],
        totalRows: 5,
        columnCount: 1,
        truncated: true,
      });
    });

    test('every row is counted even when none is kept', () => {
      expect(preview(fiveRows, ',', 0).totalRows).toBe(5);
    });

    test('a cap above the row count keeps everything', () => {
      expect(preview(fiveRows, ',', 100)).toEqual({
        header: ['h'],
        rows: [['1'], ['2'], ['3'], ['4'], ['5']],
        totalRows: 5,
        columnCount: 1,
        truncated: false,
      });
    });

    test('a cap of one keeps one row', () => {
      expect(preview(fiveRows, ',', 1).rows).toEqual([['1']]);
    });

    test('a cap below zero keeps the header and no row', () => {
      expect(preview('h\n1\n2\n', ',', -1)).toEqual({
        header: ['h'],
        rows: [],
        totalRows: 2,
        columnCount: 1,
        truncated: true,
      });
    });

    test('a cap that is not a whole number keeps the rows under it', () => {
      expect(preview('h\n1\n2\n3\n4\n', ',', 2.5).rows).toEqual([['1'], ['2']]);
    });

    test('a cap that is not a number keeps the header and no row', () => {
      expect(preview('h\n1\n2\n3\n', ',', Number.NaN).rows).toEqual([]);
    });

    test('the width of a row that was dropped does not count', () => {
      expect(preview('a,b\n1,2,3\n4,5\n', ',', 1)).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2', '3']],
        totalRows: 2,
        columnCount: 3,
        truncated: true,
      });
    });

    test('a blank line does not use up the cap', () => {
      expect(preview('h\n\n1\n\n2\n', ',', 1)).toEqual({
        header: ['h'],
        rows: [['1']],
        totalRows: 2,
        columnCount: 1,
        truncated: true,
      });
    });

    test('a quoted newline stays inside its row', () => {
      expect(preview('h\n"a\nb"\n2\n', ',', 1)).toEqual({
        header: ['h'],
        rows: [['a\nb']],
        totalRows: 2,
        columnCount: 1,
        truncated: true,
      });
    });
  });
});

describe('the place of a row in the source', () => {
  test('points at the text of the row', () => {
    const content = 'name,age\nAda,36\nLinus,54\n';
    const table = parseDelimitedText(content, ',');
    expect(table.rows).toEqual([{ start: 9, end: 15 }, { start: 16, end: 24 }]);
    expect(content.slice(table.rows[0].start, table.rows[0].end)).toBe('Ada,36');
    expect(content.slice(table.rows[1].start, table.rows[1].end)).toBe('Linus,54');
  });

  test('a row that ends inside a quoted field reaches the end of the file', () => {
    const content = 'h\n"a\nb';
    const table = parseDelimitedText(content, ',');
    expect(content.slice(table.rows[0].start, table.rows[0].end)).toBe('"a\nb');
  });

  test('a row of a file that starts with a byte order mark is placed after it', () => {
    const content = '﻿h\n1\n';
    const table = parseDelimitedText(content, ',');
    expect(table.rows[0].start).toBe(3);
    expect(content.slice(table.rows[0].start, table.rows[0].end)).toBe('1');
  });

  test('the header is cut out of the source', () => {
    const table = parseDelimitedText('name,age\nAda,36\n', ',');
    expect(table.header).toEqual(['name', 'age']);
  });
});

describe('the width of the columns', () => {
  test('is the width of the widest kept value of every column', () => {
    const table = parseDelimitedText('a,b\nlong,2\nx,yyyyyyyy\n', ',');
    expect(table.columnCells).toEqual([4, 8]);
  });

  test('a row that was dropped does not count', () => {
    const table = parseDelimitedText('a,b\n1,2\nxxxxx,3\n', ',', 1);
    expect(table.columnCells).toEqual([1, 1]);
  });

  test('the header is not part of the body', () => {
    const table = parseDelimitedText('a very long header,b\n1,2\n', ',');
    expect(table.columnCells).toEqual([1, 1]);
  });

  test('a column the body does not reach has no width', () => {
    const table = parseDelimitedText('a,b,c\n1\n', ',');
    expect(table.columnCells).toEqual([1, 0, 0]);
  });

  test('a character outside latin counts as two cells', () => {
    const table = parseDelimitedText('a\n東京\n', ',');
    expect(table.columnCells).toEqual([4]);
  });

  test('a character the browser measured is counted at the width it takes', () => {
    const widths = characterWidthsFrom(new Map([['κ'.codePointAt(0) ?? 0, 8.27]]), 7.5);
    const table = parseDelimitedText('a\nκκκ\n', ',', 2_000, widths);
    const measured = 3 * (8.27 / 7.5);
    expect(Math.abs(table.columnCells[0] - measured)).toBeLessThan(0.000001);
  });
});

describe('the characters outside latin', () => {
  /** The code points the check uses, the way the model keys them. */
  const ALPHA = 'α'.codePointAt(0) ?? 0;
  const GAMMA = 'γ'.codePointAt(0) ?? 0;
  const DELTA = 'δ'.codePointAt(0) ?? 0;

  test('are collected once each', () => {
    const table = parseDelimitedText('α,b\nγα,δ\nα', ',');
    expect([...table.codePoints].sort((left, right) => left - right)).toEqual([ALPHA, GAMMA, DELTA]);
  });

  test('are not collected for a file of plain latin characters', () => {
    expect(parseDelimitedText('name\nalice', ',').codePoints).toEqual([]);
  });

  test('are collected as the one character a pair of code units is', () => {
    expect(parseDelimitedText('🙂', ',').codePoints).toEqual(['🙂'.codePointAt(0)]);
  });

  test('stop at the limit of the measurement', () => {
    const many = Array.from({ length: 2_000 }, (_, index) => String.fromCharCode(0x3000 + index)).join('');
    expect(parseDelimitedText(many, ',').codePoints).toHaveLength(1_024);
  });

  test('are collected from a row the parser dropped as well', () => {
    // The characters of a row the parser dropped are in no value that is
    // counted, so they change no width, but the browser measures them all
    // the same.
    const table = parseDelimitedText('alice\n東京', ',', 0);
    expect(table.codePoints).toEqual(['東'.codePointAt(0), '京'.codePointAt(0)]);
  });

  test('are not the byte order mark a file may start with', () => {
    // The parser reads a file that starts with a byte order mark without
    // it, so the mark is not one of the characters of the data.
    expect(parseDelimitedText('﻿name\nalice', ',').codePoints).toEqual([]);
  });
});

describe('the parser against the parser it replaces', () => {
  test('every file of a random shape is parsed the same way', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const delimiter = seed % 2 === 0 ? ',' : '\t';
      const content = randomFile(seed, delimiter);
      const rowCap = CAPS[seed % CAPS.length] ?? 2_000;

      const expected = referenceParseDelimitedText(content, delimiter, rowCap);
      const table = parseDelimitedText(content, delimiter, rowCap);

      expect({
        content,
        header: table.header,
        rows: table.rows.map((row) => cutDelimitedRow(content, row, delimiter)),
        totalRows: table.totalRows,
        columnCount: table.columnCount,
        truncated: table.truncated,
      }).toEqual({
        content,
        header: expected.header,
        rows: expected.rows,
        totalRows: expected.totalRows,
        columnCount: expected.columnCount,
        truncated: expected.truncated,
      });
    }
  });

  test('the widths of the columns are the ones the preview used to find', () => {
    const metrics: TableCellMetrics = {
      charWidth: 7.5,
      cellPadding: 16,
      cellBorder: 1,
      maxCellWidth: 512,
    };
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const delimiter = seed % 2 === 0 ? ',' : '\t';
      const content = randomFile(seed, delimiter);
      const rowCap = CAPS[seed % CAPS.length] ?? 2_000;

      const expected = referenceParseDelimitedText(content, delimiter, rowCap);
      const table = parseDelimitedText(content, delimiter, rowCap);

      expect(measureTableColumns(
        table.header.map((value) => displayCells(value)),
        table.columnCells,
        table.columnCount,
        metrics,
      )).toEqual(referenceMeasureTableColumns(
        expected.header,
        expected.rows,
        expected.columnCount,
        metrics,
      ));
    }
  });

  test('the widths are the same when the browser measured the characters', () => {
    const metrics: TableCellMetrics = {
      charWidth: 7.5,
      cellPadding: 16,
      cellBorder: 1,
      maxCellWidth: 512,
    };
    for (let seed = 1; seed <= 500; seed += 1) {
      const delimiter = seed % 2 === 0 ? ',' : '\t';
      const content = randomFile(seed, delimiter);
      const rowCap = CAPS[seed % CAPS.length] ?? 2_000;

      // The characters the browser would measure, each of them a little wider
      // than the count gives it.
      const advances = new Map<number, number>();
      for (const code of referenceCollectNonLatinCodePoints(content, 100)) {
        advances.set(code, 8.27);
      }
      const widths = characterWidthsFrom(advances, metrics.charWidth);

      const expected = referenceParseDelimitedText(content, delimiter, rowCap);
      const table = parseDelimitedText(content, delimiter, rowCap, widths);

      expect(measureTableColumns(
        table.header.map((value) => displayCells(value, widths)),
        table.columnCells,
        table.columnCount,
        metrics,
      )).toEqual(referenceMeasureTableColumns(
        expected.header,
        expected.rows,
        expected.columnCount,
        metrics,
        widths,
      ));
    }
  });

  test('the characters outside latin are the ones the preview used to find', () => {
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const delimiter = seed % 2 === 0 ? ',' : '\t';
      const content = randomFile(seed, delimiter);

      expect(parseDelimitedText(content, delimiter).codePoints)
        .toEqual(referenceCollectNonLatinCodePoints(content, 1_024));
    }
  });

  test('the header of a file of a random shape is the header the preview used to cut', () => {
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const delimiter = seed % 2 === 0 ? ',' : '\t';
      const content = randomFile(seed, delimiter);

      expect(parseDelimitedText(content, delimiter).header)
        .toEqual(referenceParseDelimitedText(content, delimiter).header);
    }
  });
});

describe('the count of the widths of the columns', () => {
  test('counts the widths the parse counts', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const delimiter = seed % 2 === 0 ? ',' : '\t';
      const content = randomFile(seed, delimiter);
      const rowCap = CAPS[seed % CAPS.length] ?? 2_000;

      // The characters the browser would measure, each of them a little wider
      // than the count gives it.
      const advances = new Map<number, number>();
      for (const code of referenceCollectNonLatinCodePoints(content, 100)) {
        advances.set(code, 8.27);
      }
      const widths = characterWidthsFrom(advances, 7.5);

      expect(countDelimitedColumnCells(content, delimiter, rowCap, widths))
        .toEqual(parseDelimitedText(content, delimiter, rowCap, widths).columnCells);
    }
  });

  test('counts the widths the parse counts without a measurement', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const delimiter = seed % 2 === 0 ? ',' : '\t';
      const content = randomFile(seed, delimiter);
      const rowCap = CAPS[seed % CAPS.length] ?? 2_000;

      expect(countDelimitedColumnCells(content, delimiter, rowCap))
        .toEqual(parseDelimitedText(content, delimiter, rowCap).columnCells);
    }
  });

  test('counts the rows the preview holds and not the rows after them', () => {
    // The rows the preview holds are a prefix of the file, and the count
    // stops at the end of the last of them.
    const content = 'h\n1\n2\n3\n4\n5\n';

    expect(countDelimitedColumnCells(content, ',', 2)).toEqual([1]);
    expect(countDelimitedColumnCells(content, ',', 0))
      .toEqual(parseDelimitedText(content, ',', 0).columnCells);
  });

  test('counts the width of the widest value of every column', () => {
    expect(countDelimitedColumnCells('a,b\nlong,2\nx,yyyyyyyy\n', ',')).toEqual([4, 8]);
  });
});
