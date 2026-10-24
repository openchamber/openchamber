import { describe, expect, test } from 'bun:test';

import {
  HTML_MAX_COLSPAN,
  TABLE_WHOLE_GRID_CELL_LIMIT,
  characterWidthsFrom,
  clampTableWindow,
  columnWidth,
  computeTableWindow,
  displayCells,
  holdsWholeTable,
  measureTableColumns,
  planTableColumns,
  tableSpacerSpans,
  tableWidthCss,
  visibleColumnRange,
  visibleRowRange,
  type TableCellMetrics,
  type TableCharacterWidths,
} from './tableLayout';

const METRICS: TableCellMetrics = {
  charWidth: 7.5,
  cellPadding: 16,
  cellBorder: 1,
  maxCellWidth: 512,
};

/**
 * The width of the widest value of every column, the way the parser counts
 * them as it reads a file: the width of a value is the width of its
 * characters, and the widest value of a column is the width of the column.
 */
const bodyCells = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columnCount: number,
  characterWidths?: TableCharacterWidths,
): number[] => {
  const cells = new Array<number>(columnCount).fill(0);
  for (const row of rows) {
    const fields = Math.min(row.length, columnCount);
    for (let column = 0; column < fields; column += 1) {
      const width = displayCells(row[column], characterWidths);
      if (width > cells[column]) cells[column] = width;
    }
  }
  return cells;
};

/**
 * The plan of one table: the widths the columns ask for, and the room the
 * panel has shared out over them.
 *
 * The header's values are counted on their own, and the body comes in as the
 * width of the widest value of every column, which is what the parser hands
 * over.
 */
const tablePlan = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columnCount: number,
  metrics: TableCellMetrics,
  viewportWidth: number,
  characterWidths?: TableCharacterWidths,
) => planTableColumns(
  measureTableColumns(
    header.map((value) => displayCells(value, characterWidths)),
    bodyCells(rows, columnCount, characterWidths),
    columnCount,
    metrics,
  ),
  metrics,
  viewportWidth,
);

describe('displayCells', () => {
  test('counts a latin character as one cell', () => {
    expect(displayCells('alice')).toBe(5);
    expect(displayCells('')).toBe(0);
  });

  test('counts a full-width character as two cells', () => {
    expect(displayCells('名前')).toBe(4);
    expect(displayCells('a名')).toBe(3);
  });

  test('counts a character outside the basic plane once', () => {
    expect(displayCells('🙂')).toBe(2);
    expect(displayCells('a🙂')).toBe(3);
  });
});

describe('planTableColumns', () => {
  test('sizes a column to its longest value', () => {
    const plan = tablePlan(['name', 'city'], [['alice', 'Lisbon'], ['bo', 'Porto']], 2, METRICS, 0);
    expect(plan.cells).toEqual([5, 6]);
    // The first column carries the border, the last one does not.
    expect(plan.boundaries).toEqual([0, 54.5, 115.5]);
    expect(plan.totalWidth).toBe(115.5);
  });

  test('keeps a header that is longer than every value', () => {
    const plan = tablePlan(['a very long header'], [['x']], 1, METRICS, 0);
    expect(plan.cells).toEqual([18]);
    expect(plan.boundaries).toEqual([0, 18 * 7.5 + 16]);
  });

  test('caps a long value but not a long header', () => {
    const capped = tablePlan(['h'], [['x'.repeat(200)]], 1, METRICS, 0);
    // 66 cells fit under the cap: 66 * 7.5 + 16 = 511.
    expect(capped.cells).toEqual([66]);
    expect(capped.totalWidth).toBe(511);

    const header = tablePlan(['h'.repeat(200)], [['x']], 1, METRICS, 0);
    expect(header.cells).toEqual([200]);
    expect(header.totalWidth).toBe(200 * 7.5 + 16);
  });

  test('shares the room left over in a wider panel over the columns', () => {
    const plan = tablePlan(['a', 'b'], [['x', 'y']], 2, METRICS, 200);
    // The columns ask for 24.5 px and 23.5 px, and the room the panel has is
    // shared out over them in proportion to that.
    expect(plan.totalWidth).toBe(200);
    expect(plan.boundaries[1]).toBe(24.5 * (200 / 48));
  });

  test('shares the room left over in proportion to the columns', () => {
    // The first column asks for 54.5px, the second for 23.5px.
    const plan = tablePlan(['a', 'b'], [['xxxxx', 'y']], 2, METRICS, 156);
    expect(plan.boundaries).toEqual([0, 109, 156]);
  });

  test('keeps the columns at their own width in a narrower panel', () => {
    const plan = tablePlan(['a', 'b'], [['x', 'y']], 2, METRICS, 40);
    expect(plan.boundaries).toEqual([0, 24.5, 48]);
  });

  test('counts a wide character as two cells of the column', () => {
    const plan = tablePlan(['名前'], [['名']], 1, METRICS, 0);
    expect(plan.cells).toEqual([4]);
  });

  test('counts a plain latin value by the length of its characters', () => {
    const plan = tablePlan(['name'], [['alice'], ['bo']], 1, METRICS, 0);
    expect(plan.cells).toEqual([5]);
  });
});

describe('the count of a value', () => {
  /** The width the browser gives a greek letter, in px. */
  const ALPHA_ADVANCE = 8.27;
  const ALPHA = 'α'.codePointAt(0) ?? 0;

  test('is the count of that value, whatever the rest of the file holds', () => {
    // A plain latin value takes one cell per character, and a file whose
    // other rows hold characters outside latin does not change it.
    const alone = tablePlan(['name'], [['alice']], 1, METRICS, 0);
    const beside = tablePlan(['name'], [['alice'], ['東京']], 1, METRICS, 0);

    expect(alone.cells).toEqual([5]);
    expect(beside.cells).toEqual([5]);
  });

  test('does not change the width of another column', () => {
    // The count of a value is the count of that value, so a row with
    // characters outside latin does not change the width of a column that
    // holds the same values without it.
    const without = tablePlan(['h', 'h'], [['alice', 'bo']], 2, METRICS, 0);
    const withWide = tablePlan(['h', 'h'], [['alice', 'bo'], ['東京', 'x']], 2, METRICS, 0);

    expect(withWide.cells[0]).toBe(without.cells[0]);
  });

  test('is the width the browser gives the characters of a value', () => {
    // A value in a script the monospace font does not cover is counted at
    // the width the browser gives its characters, and the plain latin value
    // beside it keeps its length.
    const widths = characterWidthsFrom(new Map([[ALPHA, ALPHA_ADVANCE]]), METRICS.charWidth);
    const plan = tablePlan(['h', 'h'], [['alice', 'α'.repeat(10)]], 2, METRICS, 0, widths);

    // The first column is as wide as the five characters of its value.
    expect(plan.cells[0]).toBe(5);
    // The second one is as wide as the ten characters the browser measured,
    // which take more room than the count gives them.
    expect(plan.cells[1]).toBeGreaterThan(10);
    expect(plan.cells[1]).toBeLessThan(12);
  });
});

describe('the widths of the columns and the room of the panel', () => {
  const header = ['name', 'city'];
  const rows = [['alice', 'Lisbon'], ['bo', 'Porto']];

  test('keeps the widths the data asks for when the panel grows', () => {
    const widths = measureTableColumns(
      header.map((value) => displayCells(value)),
      bodyCells(rows, 2),
      2,
      METRICS,
    );
    const narrow = planTableColumns(widths, METRICS, 0);
    const wide = planTableColumns(widths, METRICS, 400);

    // The widths come from the data, so a wider panel does not ask the
    // columns for anything else.
    expect(wide.cells).toEqual(narrow.cells);
    expect(wide.totalCells).toBe(narrow.totalCells);

    // The room the panel has is shared out over them.
    expect(wide.boundaries).not.toEqual(narrow.boundaries);
    expect(wide.totalWidth).toBe(400);
  });
});

describe('the width every column asks for', () => {
  test('takes the header and the body as they are counted', () => {
    const widths = measureTableColumns([9, 3], [4, 7], 2, METRICS);
    expect(widths.cells).toEqual([9, 7]);
    expect(widths.totalCells).toBe(16);
  });

  test('caps the body and not the header', () => {
    // 66 cells fit under the cap: 66 * 7.5 + 16 = 511.
    expect(measureTableColumns([1], [200], 1, METRICS).cells).toEqual([66]);
    expect(measureTableColumns([200], [200], 1, METRICS).cells).toEqual([200]);
  });

  test('rounds a width up to the precision of a cell', () => {
    expect(measureTableColumns([1.0004], [0], 1, METRICS).cells).toEqual([1.001]);
  });

  test('a column neither the header nor the body reaches has no width', () => {
    const widths = measureTableColumns([4], [4], 3, METRICS);
    expect(widths.cells).toEqual([4, 0, 0]);
    expect(widths.totalCells).toBe(4);
  });
});

describe('the characters outside latin', () => {
  /** The code points the check uses, the way the model keys them. */
  const ALPHA = 'α'.codePointAt(0) ?? 0;
  const YA = 'я'.codePointAt(0) ?? 0;

  test('are counted at the width the browser measured for them', () => {
    // A character the monospace font does not cover falls back to another
    // font, and that font can lay it out wider than the monospace font. The
    // value is counted at the width the browser gives the character, so the
    // column is as wide as the text the browser lays out.
    const advance = 8.27;
    const widths = characterWidthsFrom(new Map([[ALPHA, advance]]), METRICS.charWidth);
    const plan = tablePlan(['h'], [['α'.repeat(40)]], 1, METRICS, 0, widths);

    // The text takes 330.8 px, and the column is as wide as that.
    expect(plan.totalWidth).toBeGreaterThanOrEqual(40 * advance + METRICS.cellPadding);
    // And not wider than a fraction of a cell more than it has to be.
    expect(plan.totalWidth).toBeLessThan(40 * advance + METRICS.cellPadding + 1);
  });

  test('keep the counted width of a character the browser lays out narrower', () => {
    // A character that takes less room than the monospace font does keeps
    // the cell the count gives it, so the column is not padded with room
    // the text does not need.
    const widths = characterWidthsFrom(new Map([[YA, 7.19]]), METRICS.charWidth);
    const plan = tablePlan(['h'], [['я'.repeat(40)]], 1, METRICS, 0, widths);

    expect(plan.cells).toEqual([40]);
    expect(plan.totalWidth).toBe(40 * METRICS.charWidth + METRICS.cellPadding);
  });

  test('are counted at the width of each of them', () => {
    const widths = characterWidthsFrom(new Map([[ALPHA, 8.27], [YA, 7.19]]), METRICS.charWidth);

    // The character the browser lays out wider is counted at the width it
    // takes there, and the one it lays out narrower keeps the counted width.
    expect(Math.abs((widths.get(ALPHA) ?? 0) - 8.27 / METRICS.charWidth)).toBeLessThan(0.000001);
    expect(widths.get(YA)).toBe(1);
  });

  test('are counted at the width the browser measured for them in a value', () => {
    // A value that mixes a character the browser lays out wider with one it
    // lays out narrower is as wide as the text the browser lays out.
    const widths = characterWidthsFrom(new Map([[ALPHA, 8.27], [YA, 7.19]]), METRICS.charWidth);
    const plan = tablePlan(['h'], [['ααααя']], 1, METRICS, 0, widths);

    const text = 4 * 8.27 + 7.19;
    expect(plan.totalWidth).toBeGreaterThanOrEqual(text + METRICS.cellPadding);
    expect(plan.totalWidth).toBeLessThan(text + METRICS.cellPadding + 1);
  });
});

describe('the cap on a cell', () => {
  /**
   * The advance a browser measures in Chromium. The measured text box is
   * rounded up to the next 1/64 px, so the measured advance is a hair above
   * the one the layout uses.
   */
  const MEASURED_ADVANCE = 7.50006103515625;
  const MEASURED_METRICS: TableCellMetrics = { ...METRICS, charWidth: MEASURED_ADVANCE };

  test('keeps a value that fits the room of the cell', () => {
    // 66 characters take 495 px, which is the room the cell has.
    const plan = tablePlan(['h'], [['x'.repeat(66)]], 1, MEASURED_METRICS, 0);
    expect(plan.cells).toEqual([66]);
    expect(plan.totalWidth).toBeLessThanOrEqual(METRICS.maxCellWidth + 1 / 64);
  });

  test('cuts a value one character over the room short', () => {
    const plan = tablePlan(['h'], [['x'.repeat(67)]], 1, MEASURED_METRICS, 0);
    expect(plan.cells).toEqual([66]);
  });

  test('keeps a value that fits at an advance that does not divide the room', () => {
    // 58 characters of 8.4 px take 487.2 px and fit, 59 take 495.6 px and do not.
    const metrics: TableCellMetrics = { ...METRICS, charWidth: 8.4 };
    expect(tablePlan(['h'], [['x'.repeat(58)]], 1, metrics, 0).cells).toEqual([58]);
    expect(tablePlan(['h'], [['x'.repeat(59)]], 1, metrics, 0).cells).toEqual([58]);
  });

  test('counts a full-width character as two cells of the cap', () => {
    // 33 full-width characters take 66 cells and fit, 34 take 68 and do not.
    expect(tablePlan(['h'], [['名'.repeat(33)]], 1, MEASURED_METRICS, 0).cells).toEqual([66]);
    expect(tablePlan(['h'], [['名'.repeat(34)]], 1, MEASURED_METRICS, 0).cells).toEqual([66]);
  });

  test('keeps the column within the cap on the cell', () => {
    const plan = tablePlan(['h'], [['x'.repeat(200)]], 1, MEASURED_METRICS, 0);
    expect(plan.totalWidth).toBeLessThanOrEqual(METRICS.maxCellWidth + 1 / 64);
  });
});

describe('visibleRowRange', () => {
  const options = {
    viewportHeight: 300,
    headerHeight: 27,
    rowHeight: 27,
    rowCount: 100,
    overscan: 2,
  };

  test('starts at the first row and keeps the overscan below the viewport', () => {
    expect(visibleRowRange({ ...options, scrollTop: 0 })).toEqual({ start: 0, end: 14 });
  });

  test('takes the rows the sticky header covers off the viewport', () => {
    // One row down: the row under the header is the second one.
    expect(visibleRowRange({ ...options, scrollTop: 27 })).toEqual({ start: 0, end: 15 });
    expect(visibleRowRange({ ...options, scrollTop: 54 })).toEqual({ start: 0, end: 16 });
  });

  test('follows the scroll offset', () => {
    expect(visibleRowRange({ ...options, scrollTop: 27 + 100 * 27 })).toEqual({ start: 99, end: 100 });
  });

  test('reaches the last row when the table is scrolled to the end', () => {
    const last = visibleRowRange({ ...options, scrollTop: 27 + 99 * 27 });
    expect(last.end).toBe(100);
  });

  test('has no rows for an empty table', () => {
    expect(visibleRowRange({ ...options, scrollTop: 0, rowCount: 0 })).toEqual({ start: 0, end: 0 });
  });
});

describe('visibleColumnRange', () => {
  const boundaries = [0, 100, 200, 300, 400];
  const options = {
    viewportWidth: 200,
    boundaries,
    columnCount: 4,
    overscan: 1,
    direction: 'ltr' as const,
  };

  test('starts at the first column and keeps the overscan beside the viewport', () => {
    expect(visibleColumnRange({ ...options, scrollLeft: 0 })).toEqual({ start: 0, end: 3 });
  });

  test('follows the scroll offset', () => {
    expect(visibleColumnRange({ ...options, scrollLeft: 250 })).toEqual({ start: 1, end: 4 });
  });

  test('reads a right-to-left table from its other edge', () => {
    // At the start of a right-to-left table the first column is on screen.
    expect(visibleColumnRange({ ...options, scrollLeft: 0, direction: 'rtl' })).toEqual({ start: 0, end: 3 });
    // Scrolled to the other end, the last column is on screen.
    expect(visibleColumnRange({ ...options, scrollLeft: -200, direction: 'rtl' })).toEqual({ start: 1, end: 4 });
  });

  test('maps a right-to-left table whose columns are not all the same width', () => {
    // Five columns of 60, 90, 50, 120 and 180 px. The columns of the same
    // width make the mirrored boundaries the plain ones, so the mapping from
    // the physical order to the order of the file cannot be seen.
    const uneven = {
      viewportWidth: 200,
      boundaries: [0, 60, 150, 200, 320, 500],
      columnCount: 5,
      overscan: 1,
      direction: 'rtl' as const,
    };

    // A right-to-left table is read from its right edge, and the offset is
    // turned into the distance from the left edge of the content. At 150 px
    // from that edge the last three columns of the file are on screen, and
    // the one before them is kept as the overscan.
    expect(visibleColumnRange({ ...uneven, scrollLeft: -150 })).toEqual({ start: 1, end: 5 });
    // The same offset in a left-to-right table names other columns.
    expect(visibleColumnRange({ ...uneven, scrollLeft: -150, direction: 'ltr' })).toEqual({ start: 0, end: 2 });
  });

  test('has no columns for an empty table', () => {
    expect(visibleColumnRange({ ...options, scrollLeft: 0, columnCount: 0 })).toEqual({ start: 0, end: 0 });
  });
});

describe('computeTableWindow', () => {
  test('maps one scroll position to both axes', () => {
    const plan = tablePlan(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      [['x'.repeat(10), 'y'.repeat(10), 'z'.repeat(10), 'w'.repeat(10), 'v'.repeat(10), 'u'.repeat(10), 't'.repeat(10), 's'.repeat(10)]],
      8,
      METRICS,
      0,
    );
    const window = computeTableWindow({
      plan,
      viewportWidth: 200,
      viewportHeight: 300,
      headerHeight: 27,
      rowHeight: 27,
      rowCount: 100,
      columnCount: 8,
      rowOverscan: 2,
      columnOverscan: 1,
      direction: 'ltr',
    }, 27 + 10 * 27, 300);
    expect(window.rows).toEqual({ start: 9, end: 25 });
    expect(window.columns).toEqual({ start: 2, end: 7 });
  });
});

describe('clampTableWindow', () => {
  test('holds the window inside the file', () => {
    // The window of the file before names more columns than the file that is
    // open now has, and more rows than it has.
    expect(clampTableWindow(
      { rows: { start: 0, end: 20 }, columns: { start: 0, end: 20 } },
      4,
      10,
    )).toEqual({ rows: { start: 0, end: 10 }, columns: { start: 0, end: 4 } });
  });

  test('keeps one column when the window starts past the end of the file', () => {
    expect(clampTableWindow(
      { rows: { start: 0, end: 1 }, columns: { start: 30, end: 50 } },
      4,
      10,
    ).columns).toEqual({ start: 3, end: 4 });
  });

  test('keeps one row when the window starts past the end of the file', () => {
    expect(clampTableWindow(
      { rows: { start: 100, end: 130 }, columns: { start: 0, end: 1 } },
      4,
      10,
    ).rows).toEqual({ start: 9, end: 10 });
  });

  test('has nothing for a file without rows or columns', () => {
    expect(clampTableWindow(
      { rows: { start: 0, end: 5 }, columns: { start: 0, end: 5 } },
      0,
      0,
    )).toEqual({ rows: { start: 0, end: 0 }, columns: { start: 0, end: 0 } });
  });

  test('leaves a window that is inside the file alone', () => {
    const inside = { rows: { start: 2, end: 8 }, columns: { start: 1, end: 5 } };
    expect(clampTableWindow(inside, 10, 20)).toEqual(inside);
  });
});

describe('the width the table is written with', () => {
  test('adds the measured padding and the border to the characters', () => {
    expect(columnWidth(10, METRICS, false).css).toBe('calc(10ch + 16px + 1px)');
    expect(columnWidth(10, METRICS, true).css).toBe('calc(10ch + 16px)');
  });

  test('writes the width from the measurement, so a change to the cell moves it', () => {
    const changed: TableCellMetrics = { ...METRICS, cellPadding: 24, cellBorder: 2 };
    expect(columnWidth(10, changed, false).css).toBe('calc(10ch + 24px + 2px)');
    expect(columnWidth(10, changed, true).css).toBe('calc(10ch + 24px)');
  });

  test('adds up the columns for the table', () => {
    expect(tableWidthCss(30, 4, METRICS)).toBe('calc(30ch + 64px + 3px)');
    expect(tableWidthCss(0, 0, METRICS)).toBe('calc(0ch + 0px + 0px)');
  });
});

describe('the cells that carry the columns outside the window', () => {
  test('holds the limit HTML puts on the colspan of a cell', () => {
    // HTML limits the colspan of a cell to 1000. The attribute keeps the
    // value that was written, but the browser lays the cell out over 1000
    // columns at the most.
    expect(HTML_MAX_COLSPAN).toBe(1_000);
  });

  test('carries a range that fits in one cell with one cell', () => {
    expect(tableSpacerSpans(0)).toEqual([]);
    expect(tableSpacerSpans(1)).toEqual([1]);
    expect(tableSpacerSpans(999)).toEqual([999]);
    expect(tableSpacerSpans(HTML_MAX_COLSPAN)).toEqual([HTML_MAX_COLSPAN]);
  });

  test('carries a range that is wider than a cell may span with more than one cell', () => {
    expect(tableSpacerSpans(HTML_MAX_COLSPAN + 1)).toEqual([HTML_MAX_COLSPAN, 1]);
    expect(tableSpacerSpans(1_500)).toEqual([1_000, 500]);
    expect(tableSpacerSpans(5_000)).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
  });

  test('covers every column of the range and spans no more than HTML allows', () => {
    for (const columns of [0, 1, 999, 1_000, 1_001, 2_000, 5_000, 32_767]) {
      const spans = tableSpacerSpans(columns);
      expect(spans.reduce((sum, span) => sum + span, 0)).toBe(columns);
      for (const span of spans) {
        expect(span).toBeGreaterThan(0);
        expect(span).toBeLessThanOrEqual(HTML_MAX_COLSPAN);
      }
    }
  });
});

describe('the width the browser is given and the width the model reasons about', () => {
  const widths = { cells: [4, 9, 2], totalCells: 15 };

  /**
   * The px the width written for the browser adds to the characters: the
   * padding and the border of a cell.
   */
  const chromeOf = (css: string): number => {
    const terms = css.match(/([\d.]+)px/g) ?? [];
    return terms.reduce((sum, term) => sum + Number.parseFloat(term), 0);
  };

  /** The characters the width written for the browser asks for. */
  const cellsOf = (css: string): number => Number.parseFloat(css.match(/([\d.]+)ch/)?.[1] ?? '0');

  /**
   * The difference between two widths. The widths are sums of floats, so
   * they are compared with a margin.
   */
  const difference = (left: number, right: number): number => Math.abs(left - right);

  test('are the same width for every column', () => {
    const plan = planTableColumns(widths, METRICS, 0);
    for (let column = 0; column < widths.cells.length; column += 1) {
      const isLastColumn = column === widths.cells.length - 1;
      const css = columnWidth(widths.cells[column], METRICS, isLastColumn).css;
      // The characters are the same on both sides.
      expect(cellsOf(css)).toBe(widths.cells[column]);
      // And so is the padding and the border around them.
      const modelChrome = plan.boundaries[column + 1]
        - plan.boundaries[column]
        - widths.cells[column] * METRICS.charWidth;
      expect(difference(chromeOf(css), modelChrome)).toBeLessThan(0.000001);
    }
  });

  test('the last column keeps its missing border', () => {
    const plan = planTableColumns(widths, METRICS, 0);
    const last = widths.cells.length - 1;
    // The last column carries the padding but not the border, so it is
    // narrower than the one before it by exactly the border.
    const lastChrome = plan.boundaries[last + 1]
      - plan.boundaries[last]
      - widths.cells[last] * METRICS.charWidth;
    const beforeChrome = plan.boundaries[last]
      - plan.boundaries[last - 1]
      - widths.cells[last - 1] * METRICS.charWidth;
    expect(difference(beforeChrome - lastChrome, METRICS.cellBorder)).toBeLessThan(0.000001);
  });

  test('a change to the padding or the border of a cell moves both', () => {
    const changed: TableCellMetrics = { ...METRICS, cellPadding: 24, cellBorder: 3 };
    const plan = planTableColumns(widths, changed, 0);
    for (let column = 0; column < widths.cells.length; column += 1) {
      const isLastColumn = column === widths.cells.length - 1;
      const css = columnWidth(widths.cells[column], changed, isLastColumn).css;
      const modelChrome = plan.boundaries[column + 1]
        - plan.boundaries[column]
        - widths.cells[column] * changed.charWidth;
      expect(difference(chromeOf(css), modelChrome)).toBeLessThan(0.000001);
    }
  });
});

describe('the size of a grid', () => {
  test('keeps a grid of few cells whole', () => {
    expect(holdsWholeTable(19, 10)).toBe(true);
    expect(holdsWholeTable(0, 100)).toBe(true);
  });

  test('windows a grid of many cells', () => {
    expect(holdsWholeTable(2_000, 50)).toBe(false);
    expect(holdsWholeTable(200, 20)).toBe(false);
  });

  test('counts the header row with the rows', () => {
    // The header row is a row of the table, so a file with a header of two
    // thousand columns holds two thousand cells and not one cell less.
    expect(holdsWholeTable(0, TABLE_WHOLE_GRID_CELL_LIMIT)).toBe(true);
    expect(holdsWholeTable(0, TABLE_WHOLE_GRID_CELL_LIMIT + 1)).toBe(false);
  });

  test('the limit is one number', () => {
    // A grid of exactly the limit is kept whole, and a grid of one cell
    // more is windowed.
    expect(holdsWholeTable(TABLE_WHOLE_GRID_CELL_LIMIT - 1, 1)).toBe(true);
    expect(holdsWholeTable(TABLE_WHOLE_GRID_CELL_LIMIT, 1)).toBe(false);
  });
});

describe('the width of a ragged file', () => {
  test('measures a ragged file the same as the file with the missing values filled in', () => {
    const ragged = [['alice', 'Lisbon'], ['bo']];
    const filled = [['alice', 'Lisbon'], ['bo', '']];
    expect(measureTableColumns(
      ['name', 'city'].map((value) => displayCells(value)),
      bodyCells(ragged, 2),
      2,
      METRICS,
    )).toEqual(measureTableColumns(
      ['name', 'city'].map((value) => displayCells(value)),
      bodyCells(filled, 2),
      2,
      METRICS,
    ));
  });

  test('keeps the width of the widest value of a column', () => {
    // The row that does not reach the second column cannot narrow it.
    const widths = measureTableColumns(
      ['name', 'city'].map((value) => displayCells(value)),
      bodyCells([['alice', 'Lisbon'], ['bo']], 2),
      2,
      METRICS,
    );
    expect(widths.cells).toEqual([5, 6]);
  });

  test('reads the width of every column and not the values of the cells', () => {
    // The measurement used to walk over the cells of the file, and the walk
    // went over the fields a row has, so a file with few fields per row and
    // many columns did not pay for the whole width of the table on every
    // row. The widths come in counted now, so the measurement reads one
    // number per column and nothing else.
    let reads = 0;
    const body = new Proxy<number[]>([1, 2, 3], {
      get(target, key) {
        if (key === 'length') return target.length;
        reads += 1;
        return target[Number(key)];
      },
    });

    measureTableColumns([4], body, 50_000, METRICS);

    // The width of every column, and nothing else.
    expect(reads).toBe(50_000);
  });
});
