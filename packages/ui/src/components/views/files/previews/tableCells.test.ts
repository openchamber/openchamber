import { describe, expect, test } from 'bun:test';

import { cellParts, columnSlots, fromTsv, selectionSummary, sortedRowOrder, toTsv } from './tableCells';

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

describe('a selection', () => {
  test('adds up what is numeric and counts everything filled', () => {
    expect(selectionSummary(['1', '2.5', '', 'x', '1,000'])).toEqual({ count: 4, sum: '1003.5', average: '334.5' });
    expect(selectionSummary(['0.1', '0.2'])?.sum).toBe('0.3');
    expect(selectionSummary(['a'])).toEqual({ count: 1, sum: '', average: '' });
    expect(selectionSummary(['', ' '])).toBeNull();
  });

  test('goes to the clipboard the way spreadsheets write it', () => {
    expect(toTsv([['a', 'b\tc'], ['line\nbreak', 'say "hi"']])).toBe('a\t"b\tc"\n"line\nbreak"\t"say ""hi"""');
  });

  test('comes back from the clipboard with empty rows in place', () => {
    expect(fromTsv('x\n\ny\n')).toEqual([['x'], [''], ['y']]);
    expect(fromTsv('a\t\tc\r\n"l\nb"\t"q""r"')).toEqual([['a', '', 'c'], ['l\nb', 'q"r']]);
  });
});

describe('a chart of a selection', () => {
  test('the first text column names the points, numeric columns are series', async () => {
    const { chartProgram } = await import('./tableChart');
    const program = chartProgram([['Pears', '3', 'x'], ['Kiwi', '2', 'y']], ['Item', 'Qty', 'Note']);
    expect(program).toContain('BarChart(["Pears","Kiwi"], [s0])');
    expect(program).toContain('s0 = Series("Qty", [3,2])');
    expect(program).not.toContain('Note');
  });

  test('dates draw a line, and no numbers draw nothing', async () => {
    const { chartProgram } = await import('./tableChart');
    expect(chartProgram([['2024-01', '1'], ['2024-02', '2']], [])).toContain('LineChart');
    expect(chartProgram([['a'], ['b']], ['x'])).toBeNull();
  });
});

describe('virtual column gaps', () => {
  test('every gap fits the HTML colspan limit without moving the drawn columns', () => {
    const cases = [
      { count: 0, drawn: [] },
      { count: 1_000, drawn: [] },
      { count: 1_001, drawn: [] },
      { count: 1_001, drawn: [1_000] },
      { count: 1_002, drawn: [1_001] },
      { count: 5_000, drawn: [0, 2_500, 4_999] },
      { count: 5_000, drawn: [4_998, 4_999] },
    ];
    for (const { count, drawn } of cases) {
      let position = 0;
      const columns: number[] = [];
      for (const slot of columnSlots(count, drawn)) {
        expect(slot.column).toBe(position);
        if (slot.span === undefined) {
          columns.push(slot.column);
          position += 1;
        } else {
          // Browsers clamp a larger colspan, shifting every subsequent cell.
          expect(slot.span > 0 && slot.span <= 1_000).toBe(true);
          position += slot.span;
        }
      }
      expect(columns).toEqual(drawn);
      expect(position).toBe(count);
    }
  });
});
