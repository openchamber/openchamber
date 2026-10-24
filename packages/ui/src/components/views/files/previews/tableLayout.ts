/**
 * The width and window model behind the delimited-text preview.
 *
 * The preview stays a real `<table>` with a sticky header, so both axes are
 * windowed inside that one table: only the rows and the columns in view are
 * in the document, and the skipped ones are carried by spacer rows and
 * spacer cells, which keep the table's own layout intact.
 *
 * Everything here is a pure function of the parsed table, the measurements
 * the browser hands over and the scroll offsets, so the mapping from a
 * scroll position to a range of cells can be checked without a browser.
 */

/**
 * What the browser charges for one character and one cell.
 *
 * The column widths themselves are written in the font's own character unit
 * (`ch`), so the browser keeps them right when the font or the interface
 * size changes. These numbers only tell the preview where the columns sit,
 * which is what the windowing needs.
 *
 * The padding and the border are read from the document, from a probe that
 * carries the classes a cell of the table carries. The width the browser is
 * given and the width the model reasons about are both built from them, so
 * a change to the stylesheet moves the two together.
 */
export type TableCellMetrics = {
  /** The px one character takes in the preview's monospace font. */
  charWidth: number;
  /** The px the inline padding of a cell adds around its text. */
  cellPadding: number;
  /** The px the end border of a cell adds on its inline end. */
  cellBorder: number;
  /** The px one cell may grow to before the cap on the cell applies. */
  maxCellWidth: number;
};

/**
 * The width of the characters outside latin, in character cells.
 *
 * A character the browser has no font for falls back to another one, and
 * that font can lay the character out wider than the monospace font of the
 * preview. The counted width of a column has to cover the text the browser
 * lays out, or the cell cuts the value short. These are the widths the
 * browser measured for the characters the file uses, one for each of them,
 * keyed by the code point of the character. A character that was not measured
 * keeps the width the count gives it.
 */
export type TableCharacterWidths = ReadonlyMap<number, number>;

/**
 * The width of the characters outside latin, before the browser measured them.
 *
 * A character outside the wide list takes one cell and a character in it takes
 * two, which is what a monospace font gives a full-width character. The
 * measured width is only used where it is wider than this one.
 */
export const DEFAULT_CHARACTER_WIDTHS: TableCharacterWidths = new Map<number, number>();

/** The width every column asks for, in character cells. */
export type TableColumnWidths = {
  /** The width of each column in character cells, the header included. */
  cells: number[];
  /** The table's width in character cells, without the cells' own padding. */
  totalCells: number;
};

/**
 * The largest number of cells a table may hold to be kept whole.
 *
 * What it costs to hold a grid is the browser's style recalculation and
 * layout of its cells, and it grows with the number of cells. The number was
 * measured in Chromium against the markup of the preview: holding 2,000
 * cells took 30 to 90 ms of layout, 4,000 cells 75 to 120 ms, 10,000 cells
 * about 300 ms and 100,000 cells 3 to 4 s. A file that holds more cells
 * than this is windowed, so the document only ever holds the cells in view.
 */
export const TABLE_WHOLE_GRID_CELL_LIMIT = 2_000;

/**
 * True when the grid of a file is small enough to be kept whole.
 *
 * A table that is kept whole holds every cell of the file in the document,
 * so the browser's find-in-page, a selection of the whole file and a screen
 * reader see the file and not the window. The decision is a property of the
 * file and not of the panel, so the same file is kept whole in a narrow
 * panel and in a wide one.
 *
 * The size of the grid is the number of cells the table holds, the header
 * row included.
 */
export const holdsWholeTable = (rowCount: number, columnCount: number): boolean => (
  (rowCount + 1) * columnCount <= TABLE_WHOLE_GRID_CELL_LIMIT
);

/**
 * The largest number of columns a cell may span.
 *
 * HTML limits the `colspan` of a cell to 1000: the attribute keeps the value
 * that was written, but the browser lays the cell out over 1000 columns at
 * most. A cell that stands for more columns than that leaves the columns
 * after it in the wrong place, so a range of columns that is wider than this
 * is carried by more than one cell.
 */
export const HTML_MAX_COLSPAN = 1000;

/**
 * The cells that carry a range of columns outside the window.
 *
 * The spans add up to the number of columns the range holds, and none of them
 * is wider than HTML allows, so the browser lays the cells of the window out
 * over the columns the model names. A range that fits in one cell is carried
 * by one cell, and the file keeps the markup it had.
 */
export const tableSpacerSpans = (columns: number): number[] => {
  const spans: number[] = [];
  let left = columns;
  while (left > 0) {
    const span = Math.min(left, HTML_MAX_COLSPAN);
    spans.push(span);
    left -= span;
  }
  return spans;
};

/** The column widths of one table and where each column starts. */
export type TableColumnPlan = TableColumnWidths & {
  /** Where each column starts in px, counted from the table's first column. */
  boundaries: number[];
  /** The table's width in px. */
  totalWidth: number;
};

/** A range of rows or columns. The end is exclusive. */
export type TableRange = {
  start: number;
  end: number;
};

/** The rows and the columns in view. */
export type TableWindow = {
  rows: TableRange;
  columns: TableRange;
};

/** The direction the table is laid out in. */
export type TableDirection = 'ltr' | 'rtl';

/**
 * The step the browser keeps its layout lengths in, a 1/64 px.
 *
 * A text box's width is rounded to the nearest step, and the box the
 * measuring probe reads is rounded up to the next one, so the advance the
 * probe measures can be a hair wider than the one the layout uses. A value
 * that needs a fraction more than the room a cell has still fits, because
 * the layout rounds it into the room. One step of room is therefore added
 * before the characters are counted, so that a value which fits is not cut
 * short, and the column stays within a step of the cap on the cell.
 */
const LAYOUT_STEP_PX = 1 / 64;

/** Matches any character outside latin, including the halves of a pair. */
const NON_ASCII = /[\u0080-\uFFFF]/;

/**
 * The width of a value in character cells.
 *
 * A character outside the wide list takes one cell and a character in the
 * wide list takes two, which is what a monospace font gives a full-width
 * character, unless the browser measured the character and it takes more
 * room than that. The measured width is only used where it is wider than
 * the counted one, so a character the browser lays out narrower does not
 * make the column wider than it has to be.
 *
 * The counted widths were measured in Chromium against the width the browser
 * lays the text out at: Latin, Thai, Arabic, Hebrew and Devanagari land on
 * the width the count asks for, and Cyrillic on 0.958 of it. CJK, Hangul and
 * Kana measured 0.500 of it on a machine without a CJK font, where the count
 * leaves twice the room; with a CJK font the glyph is 1em against a
 * monospace advance of about 0.6em, so two cells stays generous there.
 *
 * A character the browser lays out wider than the count asks for is measured
 * in the browser and counted at the width it takes there, so a value in Greek
 * or in an emoji fits its column. What the model cannot know is the width of
 * a character the measurement did not reach, and the width a font gives a
 * character in the middle of a word, such as a letter of an Arabic word,
 * which the browser shapes.
 */
export const displayCells = (
  value: string,
  widths?: TableCharacterWidths,
): number => {
  // Most values are plain latin, and the browser's own pattern match is
  // quicker than walking the characters here.
  if (!NON_ASCII.test(value)) return value.length;
  let cells = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      cells += 1;
      continue;
    }
    const point = codePointAt(value, index);
    cells += characterWidth(point, widths);
    // A character outside the basic plane is a pair of code units, and it is
    // counted as the one character it is.
    if (point > 0xffff) index += 1;
  }
  return cells;
};

/**
 * The code point of the character at a place in a text.
 *
 * A character outside the basic plane is a pair of code units, and it is
 * measured as the one character it is. A code unit that is half of a pair
 * without the other half is a character of its own.
 */
export const codePointAt = (text: string, index: number): number => {
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      return (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
  }
  return code;
};

/**
 * The width of one character outside latin, counted without a measurement.
 *
 * A character outside the wide list takes one cell and a character in the
 * wide list takes two, which is what a monospace font gives a full-width
 * character. The measured width of a character is only used where it is
 * wider than this one.
 */
const countedCharacterWidth = (code: number): number => (
  isWideCodePoint(code) ? 2 : 1
);

/**
 * The width of one character outside latin, in character cells.
 *
 * The width the browser measured for the character is used where there is
 * one, and a character the measurement did not reach keeps the width the
 * count gives it.
 */
export const characterWidth = (code: number, widths: TableCharacterWidths | undefined): number => {
  const measured = widths?.get(code);
  if (measured !== undefined) return measured;
  return countedCharacterWidth(code);
};

/**
 * Whether a character the browser measured takes more room than the count
 * gives it.
 *
 * The measured table keeps the larger of the two widths, so an entry that is
 * wider than the counted width of its character is a character the browser
 * lays out wider than the monospace font of the preview. Only such a
 * character makes the counted widths of the columns too narrow, and only such
 * a file has to count them again.
 */
export const hasWiderCharacter = (widths: TableCharacterWidths): boolean => {
  for (const [code, width] of widths) {
    if (width > countedCharacterWidth(code)) return true;
  }
  return false;
};

/**
 * Whether two tables of character widths hold the same numbers.
 *
 * The measurements keep the object they have while their values stay the
 * same, and a new table with the same numbers would ask for the count of the
 * widths again, on every frame of a drag of the panel.
 */
export const sameCharacterWidths = (
  current: TableCharacterWidths,
  next: TableCharacterWidths,
): boolean => {
  if (current.size !== next.size) return false;
  for (const [character, width] of current) {
    if (next.get(character) !== width) return false;
  }
  return true;
};

/**
 * The width of the characters of a file, from the advance the browser measured.
 *
 * Every character the file uses outside latin is counted at the width the
 * browser gives it, as long as that is more room than the counted width. A
 * value in a script the monospace font does not cover is then as wide as the
 * text the browser lays out for it.
 */
export const characterWidthsFrom = (
  advances: ReadonlyMap<number, number>,
  charWidth: number,
): TableCharacterWidths => {
  if (charWidth <= 0) return DEFAULT_CHARACTER_WIDTHS;
  const widths = new Map<number, number>();
  for (const [code, advance] of advances) {
    const cells = advance / charWidth;
    // A character that takes less room than the count gives it keeps the
    // counted width, so the column is not padded with room the text does
    // not need.
    const counted = countedCharacterWidth(code);
    widths.set(code, cells > counted ? cells : counted);
  }
  return widths;
};

const isWideCodePoint = (code: number): boolean => (
  code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd)
  )
);

/**
 * The width one column takes.
 *
 * The width in px is the one the model reasons about, and the width in CSS
 * is the one the browser is given. Both are built from the same measurement
 * of the padding and the border of a cell, so they cannot drift apart.
 *
 * The last column has no border on its inline end, so it is narrower than
 * the others by exactly the border.
 */
export type TableColumnWidth = {
  /** The width in px the browser lays the column out at. */
  px: number;
  /** The same width, written for the browser. */
  css: string;
};

/** The width of a column of the given number of characters. */
export const columnWidth = (
  cells: number,
  metrics: TableCellMetrics,
  isLastColumn: boolean,
): TableColumnWidth => {
  const border = isLastColumn ? 0 : metrics.cellBorder;
  return {
    px: cells * metrics.charWidth + metrics.cellPadding + border,
    css: `calc(${cells}ch + ${metrics.cellPadding}px${border > 0 ? ` + ${border}px` : ''})`,
  };
};

/** The width of the table, the sum of its columns. */
export const tableWidthCss = (totalCells: number, columnCount: number, metrics: TableCellMetrics): string => (
  `calc(${totalCells}ch + ${columnCount * metrics.cellPadding}px + ${Math.max(0, columnCount - 1) * metrics.cellBorder}px)`
);

/**
 * The width every column asks for, taken from the data.
 *
 * A column is as wide as its longest value, capped by the cap the cells
 * carry, and never narrower than its header, which is not capped. The header
 * and the body come in as the widths they were counted at, in character
 * cells, so the preview does not walk over the cells of the file to measure
 * them: the parser counts the values as it reads them and the preview counts
 * the header's values on their own.
 *
 * The widths come from the data and the font, so they are measured once per
 * file. The room the panel has is shared out over them afterwards, and only
 * that part is repeated when the panel is resized.
 */
export const measureTableColumns = (
  /** The width of every header value, in character cells. */
  headerCells: ReadonlyArray<number>,
  /** The width of the widest body value of every column, in character cells. */
  bodyCells: ReadonlyArray<number>,
  columnCount: number,
  metrics: TableCellMetrics,
): TableColumnWidths => {
  // The cell count a column may reach before the cap on the cell applies.
  // The cap is on the cell itself, so the room its text has is the cap
  // without the padding and the border around it.
  const maxCells = metrics.charWidth > 0
    ? Math.max(1, Math.floor((metrics.maxCellWidth - metrics.cellPadding - metrics.cellBorder + LAYOUT_STEP_PX) / metrics.charWidth))
    : Number.POSITIVE_INFINITY;

  const cells = new Array<number>(columnCount).fill(0);
  let totalCells = 0;
  for (let column = 0; column < columnCount; column += 1) {
    // A column the header does not reach and a column the body does not
    // reach have no value, and a value of no width is nothing.
    const headerWidth = headerCells[column] ?? 0;
    const bodyWidth = bodyCells[column] ?? 0;
    // The header is never capped, the body is.
    const width = Math.max(headerWidth, Math.min(bodyWidth, maxCells));
    cells[column] = roundUpCells(width);
    totalCells += cells[column];
  }

  return { cells, totalCells };
};

/**
 * The precision a column width is written with, in cells.
 *
 * The counted width of a column is a sum of measured advances, and the sum
 * carries more digits than the width needs. The count is rounded up to the
 * precision, so a column is never narrower than the text it holds.
 */
const CELL_PRECISION = 1000;

const roundUpCells = (cells: number): number => Math.ceil(cells * CELL_PRECISION) / CELL_PRECISION;

/**
 * Where the columns sit, from the widths they ask for and the room in the
 * panel.
 *
 * A table narrower than the panel fills it, the way the automatic table
 * layout filled it: the room left over is shared out over the columns in
 * proportion to the widths they asked for.
 */
export const planTableColumns = (
  widths: TableColumnWidths,
  metrics: TableCellMetrics,
  viewportWidth: number,
): TableColumnPlan => {
  const { cells, totalCells } = widths;
  // The width every column takes is the one the browser is given, so the
  // boundaries here are the boundaries the browser lays the columns out on.
  const columnWidths = cells.map((cellCells, column) => (
    columnWidth(cellCells, metrics, column === cells.length - 1).px
  ));
  const naturalWidth = columnWidths.reduce((sum, width) => sum + width, 0);
  const tableWidth = Math.max(naturalWidth, viewportWidth);
  const scale = naturalWidth > 0 ? tableWidth / naturalWidth : 1;
  const boundaries: number[] = [0];
  for (const width of columnWidths) {
    boundaries.push(boundaries[boundaries.length - 1] + width * scale);
  }

  return { cells, totalCells, boundaries, totalWidth: boundaries[boundaries.length - 1] };
};

/**
 * The rows in view.
 *
 * The sticky header covers the top of the viewport, so the rows in view are
 * the ones below it, and the row that sits at the scroll offset is the one
 * the header is about to cover. The height of a row has to match the height
 * the rows really take, or the mapping from a scroll offset to a row drifts
 * and the last row cannot be reached.
 *
 * The preview gives every row the same height, the one it measured in the
 * document, so one row height is the height of all of them.
 */
export const visibleRowRange = (options: {
  scrollTop: number;
  viewportHeight: number;
  headerHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan: number;
}): TableRange => {
  const { scrollTop, viewportHeight, headerHeight, rowHeight, rowCount, overscan } = options;
  if (rowCount <= 0) return { start: 0, end: 0 };
  const height = rowHeight > 0 ? rowHeight : 1;
  const first = Math.floor(Math.max(0, scrollTop) / height);
  const visible = Math.ceil(Math.max(0, viewportHeight - headerHeight) / height) + 1;
  const start = Math.max(0, Math.min(rowCount, first - overscan));
  const end = Math.max(start, Math.min(rowCount, first + visible + overscan));
  return { start, end };
};

/**
 * The columns in view.
 *
 * A right-to-left table puts its first column at the right, so the scroll
 * offset runs the other way and the physical order is the reverse of the
 * logical one. The range that comes back is in logical columns either way.
 *
 * The scroll offset of a right-to-left box is read the way the browser
 * reports it: 0 at the right edge of the box, and negative from there as the
 * box is scrolled towards its left edge. The offset is turned into the
 * distance from the left edge of the content, which is the direction the
 * boundaries are counted in.
 */
export const visibleColumnRange = (options: {
  scrollLeft: number;
  viewportWidth: number;
  boundaries: ReadonlyArray<number>;
  columnCount: number;
  overscan: number;
  direction: TableDirection;
}): TableRange => {
  const { scrollLeft, viewportWidth, boundaries, columnCount, overscan, direction } = options;
  if (columnCount <= 0 || boundaries.length < 2) return { start: 0, end: 0 };
  const totalWidth = boundaries[boundaries.length - 1];
  const physical = direction === 'rtl'
    ? boundaries.map((_, index) => totalWidth - boundaries[columnCount - index])
    : boundaries;
  const maxScroll = Math.max(0, totalWidth - viewportWidth);
  const offset = direction === 'rtl' ? scrollLeft + maxScroll : scrollLeft;
  const firstVisible = firstBoundaryAbove(physical, offset) - 1;
  const lastVisible = firstBoundaryAtLeast(physical, offset + viewportWidth) - 1;
  const start = Math.max(0, Math.min(columnCount, firstVisible - overscan));
  const end = Math.max(start, Math.min(columnCount, lastVisible + 1 + overscan));
  if (direction === 'rtl') return { start: columnCount - end, end: columnCount - start };
  return { start, end };
};

/** The rows and the columns in view, from one scroll position. */
export const computeTableWindow = (
  options: {
    plan: TableColumnPlan;
    viewportWidth: number;
    viewportHeight: number;
    headerHeight: number;
    rowHeight: number;
    rowCount: number;
    columnCount: number;
    rowOverscan: number;
    columnOverscan: number;
    direction: TableDirection;
  },
  scrollTop: number,
  scrollLeft: number,
): TableWindow => ({
  rows: visibleRowRange({
    scrollTop,
    viewportHeight: options.viewportHeight,
    headerHeight: options.headerHeight,
    rowHeight: options.rowHeight,
    rowCount: options.rowCount,
    overscan: options.rowOverscan,
  }),
  columns: visibleColumnRange({
    scrollLeft,
    viewportWidth: options.viewportWidth,
    boundaries: options.plan.boundaries,
    columnCount: options.columnCount,
    overscan: options.columnOverscan,
    direction: options.direction,
  }),
});

/**
 * A range that fits inside a number of rows or columns.
 *
 * The range starts no further in than the last row and ends no further out
 * than the file reaches, and it holds one row or column as long as the file
 * has one.
 */
const clampRange = (range: TableRange, count: number): TableRange => {
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(range.start, count - 1));
  const end = Math.max(start + 1, Math.min(range.end, count));
  return { start, end };
};

/**
 * The window a file of the given size can hold.
 *
 * The window of the file that was open before names the rows and the columns
 * of that file. It is held inside the file that is open now, so the first
 * commit of a new file mounts the new file's own rows and columns and not
 * the ones of the file before it.
 */
export const clampTableWindow = (
  tableWindow: TableWindow,
  columnCount: number,
  rowCount: number,
): TableWindow => ({
  rows: clampRange(tableWindow.rows, rowCount),
  columns: clampRange(tableWindow.columns, columnCount),
});

/** The first index whose boundary is past the offset. */
const firstBoundaryAbove = (boundaries: ReadonlyArray<number>, offset: number): number => {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (boundaries[middle] > offset) high = middle;
    else low = middle + 1;
  }
  return low;
};

/** The first index whose boundary has reached the offset. */
const firstBoundaryAtLeast = (boundaries: ReadonlyArray<number>, offset: number): number => {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (boundaries[middle] >= offset) high = middle;
    else low = middle + 1;
  }
  return low;
};
