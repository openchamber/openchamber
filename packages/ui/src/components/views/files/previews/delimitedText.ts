/**
 * CSV/TSV parsing for the table preview.
 *
 * RFC 4180 rules: a field wrapped in double quotes may hold the delimiter,
 * newlines and doubled quotes. The parser walks the text once and keeps, for
 * every row it holds, the place that row sits in the text. The values of a
 * row are cut out of the text when the row is needed for the preview, so a
 * file with millions of cells never holds millions of strings.
 *
 * The same walk counts the width of every value and finds the characters
 * outside latin, so the width of a column is a number the scan produces and
 * the preview does not walk over the cells to measure them. The walk over the
 * text of the file that the parser used to make a second time, to find the
 * characters, is gone with it.
 */

import { characterWidth, codePointAt, type TableCharacterWidths } from './tableLayout';

/** Where a row sits in the source text. */
export type DelimitedRow = { start: number; end: number };

export type DelimitedTable = {
  /** The header's values, cut out of the source. */
  header: string[];
  /** The place of every kept data row in the source. */
  rows: DelimitedRow[];
  /** Every data row in the file, including the ones not kept. */
  totalRows: number;
  columnCount: number;
  truncated: boolean;
  /** The width of the widest kept value of every column, in character cells. */
  columnCells: number[];
  /** The characters of the file outside latin, by their code point. */
  codePoints: number[];
};

/**
 * The rows the preview keeps of a file, unless it is asked for others.
 *
 * The preview and the count that follows it have to keep the same rows, so
 * the number is named here and both of them read it.
 */
export const DEFAULT_TABLE_ROW_CAP = 2_000;

const QUOTE_CODE = 34;
const LINE_FEED_CODE = 10;
const CARRIAGE_RETURN_CODE = 13;

/**
 * The characters outside latin the browser measures, at most.
 *
 * The list is the characters the file uses, and every one of them is drawn in
 * the browser to learn the width it takes there. A file with more distinct
 * characters than this costs more to measure than the width it gains, and the
 * characters the walk did not reach keep the width the count gives them.
 */
const CHARACTER_MEASUREMENT_LIMIT = 1_024;

export const delimiterForPath = (filePath: string): ',' | '\t' => (
  filePath.toLowerCase().endsWith('.tsv') ? '\t' : ','
);

/**
 * What the walk over the text of a file found.
 */
type DelimitedScan = {
  /** The place of the header in the source. */
  headerSpan: DelimitedRow | null;
  /** The place of every kept data row in the source. */
  rows: DelimitedRow[];
  /** Every record the walk read, the header counted with the rows. */
  totalRecords: number;
  /** The number of columns the widest kept record has. */
  columnCount: number;
  /** The width of the widest kept value of every column, in character cells. */
  columnCells: number[];
  /** The characters of the file outside latin, by their code point. */
  codePoints: number[];
};

/**
 * The walk over the text of a file.
 *
 * The walk keeps the place of every row it holds and the width of the widest
 * value of every column, so the preview never holds the cells of the file and
 * never walks over them to measure them.
 *
 * The walk stops at the end of the last kept row when it is asked to, and
 * reads the whole file otherwise. The rows it keeps are a prefix of the
 * file, so the rows after them count for nothing: a count of the widths that
 * stops there costs the walk over the first rows of the file and not over its
 * whole text.
 */
const scanDelimitedText = (
  content: string,
  delimiter: ',' | '\t',
  rowCap: number,
  characterWidths: TableCharacterWidths | undefined,
  /** Whether the walk stops at the end of the last kept row. */
  stopAtCap: boolean,
): DelimitedScan => {
  // A file that starts with a byte order mark is read without it, the way it
  // has always been read: the mark is not one of the characters of the data.
  // The text is not copied, the walk starts after the mark, and the places
  // the rows sit in are places in the text the caller holds.
  const start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  const length = content.length;
  const delimiterCode = delimiter.charCodeAt(0);

  /** The place of every kept data row in the source. */
  const rows: DelimitedRow[] = [];
  /** The place of the header in the source, cut out of it at the end. */
  let headerSpan: DelimitedRow | null = null;
  /** Every record of the file, the header counted with the rows. */
  let totalRecords = 0;
  /** Every record the preview holds, the header counted with the rows. */
  let keptRecords = 0;
  /** The number of columns the widest record the preview holds has. */
  let columnCount = 0;
  /** The width of the widest kept value of every column, in character cells. */
  const columnCells: number[] = [];

  /**
   * The characters of the file outside latin, by their code point.
   *
   * The browser lays a character out with the font it has, and a character it
   * has no font for falls back to another one, which can be wider than the
   * monospace font of the preview. Those are the characters the browser has
   * to measure, and the list holds every one of them once.
   */
  const codePoints: number[] = [];
  // The code points of the basic plane are held in a table, so the walk over
  // the characters of the file does not hash every one of them. The planes
  // above it are rare, and they are held in a set.
  const seen = new Uint8Array(0x10000);
  const above = new Set<number>();
  /** Whether the list holds as many characters as the browser may measure. */
  let codePointsFull = false;

  let position = start;
  /** The start of the record being read. */
  let recordStart = start;
  /** How many fields the record being read has, the last one still open. */
  let fieldsInRecord = 0;
  /** The width of the value of the field being read, in character cells. */
  let fieldWidth = 0;
  /** Whether the field being read has no characters in it yet. */
  let fieldIsEmpty = true;
  /**
   * Whether the record holds a quote or a delimiter, which is what tells a
   * record apart from a blank line.
   */
  let recordHasContent = false;
  let quoted = false;
  /** A record past the cap is counted but not held. */
  let collecting = true;

  /**
   * The width of the widest value of a column.
   *
   * The width of the header's values is not part of the body: the preview
   * counts the header on its own, and the cap on a cell does not reach it.
   */
  const keepWidth = (column: number, width: number): void => {
    if (!collecting || totalRecords === 0) return;
    if (column === columnCells.length) columnCells.push(0);
    if (width > columnCells[column]) columnCells[column] = width;
  };

  /**
   * The record that ends here is one the preview holds.
   *
   * The header is kept as its place in the source, and its values are cut
   * out of it at the end. A data row is kept as its place in the source too,
   * and its values are cut out of it when the row is needed.
   */
  const keepRecord = (start: number, end: number, fields: number): void => {
    if (!collecting) return;
    if (fields > columnCount) columnCount = fields;
    if (totalRecords === 0) {
      headerSpan = { start, end };
    } else {
      rows.push({ start, end });
    }
    keptRecords += 1;
  };

  while (position < length && !(stopAtCap && !collecting)) {
    // The field runs up to the next delimiter, quote or line break. Inside a
    // quoted field only the closing quote ends the run.
    let at = position;
    while (at < length) {
      const code = content.charCodeAt(at);
      if (code === QUOTE_CODE) break;
      if (!quoted && (code === delimiterCode || code === LINE_FEED_CODE || code === CARRIAGE_RETURN_CODE)) break;
      if (code < 0x80) {
        // A plain latin character takes one cell.
        fieldWidth += 1;
        at += 1;
        continue;
      }
      // A character outside latin: it is measured and collected here, so the
      // walk over the text of the file is also the walk over the values.
      const point = codePointAt(content, at);
      fieldWidth += characterWidth(point, characterWidths);
      if (!codePointsFull) {
        if (point > 0xffff) {
          if (!above.has(point)) {
            above.add(point);
            codePoints.push(point);
          }
        } else if (seen[point] === 0) {
          seen[point] = 1;
          codePoints.push(point);
        }
        if (codePoints.length >= CHARACTER_MEASUREMENT_LIMIT) codePointsFull = true;
      }
      at += point > 0xffff ? 2 : 1;
    }
    if (at > position) fieldIsEmpty = false;
    if (at >= length) {
      // The rest of the file is the last field.
      position = length;
      break;
    }

    const code = content.charCodeAt(at);
    if (code === QUOTE_CODE) {
      if (quoted) {
        if (content.charCodeAt(at + 1) === QUOTE_CODE) {
          // A doubled quote inside a quoted field is one literal quote.
          fieldWidth += 1;
          fieldIsEmpty = false;
          position = at + 2;
          continue;
        }
        // The closing quote is not part of the value.
        quoted = false;
        position = at + 1;
        continue;
      }
      // The opening quote is not part of the value either.
      quoted = true;
      recordHasContent = true;
      position = at + 1;
      continue;
    }

    if (code === delimiterCode) {
      // The field ends here.
      keepWidth(fieldsInRecord, fieldWidth);
      fieldWidth = 0;
      fieldIsEmpty = true;
      fieldsInRecord += 1;
      recordHasContent = true;
      position = at + 1;
      continue;
    }

    // A line break ends the record. A carriage return followed by a line feed
    // is one break.
    const isBlank = !recordHasContent && fieldIsEmpty;
    keepWidth(fieldsInRecord, fieldWidth);
    fieldWidth = 0;
    fieldIsEmpty = true;
    fieldsInRecord += 1;
    position = code === CARRIAGE_RETURN_CODE && content.charCodeAt(at + 1) === LINE_FEED_CODE
      ? at + 2
      : at + 1;
    if (!isBlank) {
      keepRecord(recordStart, at, fieldsInRecord);
      totalRecords += 1;
    }
    recordStart = position;
    fieldsInRecord = 0;
    recordHasContent = false;
    // The same rule the record is held by, read before the record is read:
    // the counts do not move until the record ends.
    collecting = totalRecords === 0 || keptRecords <= rowCap;
  }

  // The last record of a file that does not end in a line break. It is a
  // record when the field has something in it, when the record has fields
  // already, or when the file ended inside a quoted field. A file that ends
  // with nothing at all is a blank line, and a blank line is not a record.
  if (!fieldIsEmpty || fieldsInRecord > 0 || quoted) {
    keepWidth(fieldsInRecord, fieldWidth);
    fieldsInRecord += 1;
    keepRecord(recordStart, length, fieldsInRecord);
    totalRecords += 1;
  }

  // The columns the body reaches are the columns of the file, and a column
  // the body does not reach has no value to be wide.
  while (columnCells.length < columnCount) columnCells.push(0);

  return { headerSpan, rows, totalRecords, columnCount, columnCells, codePoints };
};

/**
 * The table of a delimited text.
 *
 * The walk keeps the place of every row it holds and the width of the widest
 * value of every column, so the preview never holds the cells of the file and
 * never walks over them to measure them. The values of a row are cut out of
 * the text when the row is needed, with `cutDelimitedRow`.
 *
 * The characters outside latin are found by the same walk, because a
 * character the browser has no font for is laid out by another font, which
 * can be wider than the monospace font of the preview, and the browser has to
 * measure every one of them.
 */
export const parseDelimitedText = (
  content: string,
  delimiter: ',' | '\t',
  rowCap: number = DEFAULT_TABLE_ROW_CAP,
  characterWidths?: TableCharacterWidths,
): DelimitedTable => {
  const scan = scanDelimitedText(content, delimiter, rowCap, characterWidths, false);
  const totalRows = Math.max(0, scan.totalRecords - 1);
  return {
    header: scan.headerSpan === null ? [] : cutDelimitedRow(content, scan.headerSpan, delimiter),
    rows: scan.rows,
    totalRows,
    columnCount: scan.columnCount,
    truncated: scan.rows.length < totalRows,
    columnCells: scan.columnCells,
    codePoints: scan.codePoints,
  };
};

/**
 * The width of the widest kept value of every column, counted with the
 * characters the browser measured.
 *
 * The widths the parse counted are the counted ones, because the parse ran
 * before the browser had measured a single character. A character the
 * browser lays out wider than the count gives it makes those widths too
 * narrow, so the widths are counted again with the measured table.
 *
 * The walk stops at the end of the last kept row: the rows the preview holds
 * are a prefix of the file, and the rows after them are not counted. A file
 * with more rows than the cap therefore costs the walk over its first rows
 * and not over its whole text.
 */
export const countDelimitedColumnCells = (
  content: string,
  delimiter: ',' | '\t',
  rowCap: number = DEFAULT_TABLE_ROW_CAP,
  characterWidths?: TableCharacterWidths,
): number[] => scanDelimitedText(content, delimiter, rowCap, characterWidths, true).columnCells;

/**
 * The values of a row, cut out of the source.
 *
 * A field is cut out of the text with slice(), so a row of five thousand
 * columns costs five thousand slices and not a string that is grown one
 * character at a time. The rules are the ones the parser follows: a field
 * wrapped in double quotes may hold the delimiter, a newline and a doubled
 * quote, and a quote inside an unquoted field is dropped.
 */
export const cutDelimitedRow = (
  content: string,
  row: DelimitedRow,
  delimiter: ',' | '\t',
): string[] => {
  const end = row.end;
  const delimiterCode = delimiter.charCodeAt(0);
  const values: string[] = [];
  /** The pieces of the value of the field being cut. */
  const pieces: string[] = [];
  /** The start of the run of characters the value is made of. */
  let runStart = row.start;
  let quoted = false;
  let position = row.start;

  while (position < end) {
    const code = content.charCodeAt(position);
    if (code === QUOTE_CODE) {
      if (quoted) {
        if (position + 1 < end && content.charCodeAt(position + 1) === QUOTE_CODE) {
          // A doubled quote inside a quoted field is one literal quote, so
          // the text before it is a piece of the value of its own.
          if (position > runStart) pieces.push(content.slice(runStart, position));
          pieces.push('"');
          position += 2;
          runStart = position;
          continue;
        }
        // The closing quote is not part of the value.
        if (position > runStart) pieces.push(content.slice(runStart, position));
        quoted = false;
        position += 1;
        runStart = position;
        continue;
      }
      // The opening quote is not part of the value either.
      if (position > runStart) pieces.push(content.slice(runStart, position));
      quoted = true;
      position += 1;
      runStart = position;
      continue;
    }
    if (!quoted && code === delimiterCode) {
      // The field ends here.
      if (position > runStart) pieces.push(content.slice(runStart, position));
      values.push(pieces.length === 1 ? pieces[0] : pieces.join(''));
      pieces.length = 0;
      position += 1;
      runStart = position;
      continue;
    }
    position += 1;
  }

  // The last field of the row.
  if (position > runStart) pieces.push(content.slice(runStart, position));
  values.push(pieces.length === 1 ? pieces[0] : pieces.join(''));
  return values;
};
