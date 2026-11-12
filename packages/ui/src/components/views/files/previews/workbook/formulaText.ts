const CELL = /(\$?)([A-Z]{1,3})(\$?)([1-9]\d{0,6})(?![\w(.])/g;

/** Runs `change` on the parts of a formula outside text in double quotes and sheet names in single quotes. */
const mapOutsideQuotes = (formula: string, change: (part: string) => string): string => formula
  .split(/("(?:[^"]|"")*"|'(?:[^']|'')*')/)
  .map((part, index) => (index % 2 === 1 ? part : change(part)))
  .join('');

const columnNumber = (name: string): number => {
  let result = 0;
  for (const character of name) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
};

const columnLetters = (number: number): string => {
  let result = '';
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
};

/**
 * A shared formula is stored once, on its first cell; the others say how far
 * they sit from it. Relative references move by that distance, `$` ones stay.
 */
export const shiftFormula = (formula: string, rows: number, columns: number): string => mapOutsideQuotes(formula, (part) => part
  .replace(/(^|[^\w.$])(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})(?![\w(])/g, (_, before: string, lockA: string, a: string, lockB: string, b: string) => {
    const move = (lock: string, name: string) => (lock ? name : columnLetters(columnNumber(name) + columns));
    return `${before}${lockA}${move(lockA, a)}:${lockB}${move(lockB, b)}`;
  })
  .replace(new RegExp(`(^|[^\\w.$])${CELL.source}`, 'g'), (match, before: string, lockColumn: string, column: string, lockRow: string, row: string) => {
    const nextColumn = lockColumn ? column : columnLetters(columnNumber(column) + columns);
    const nextRow = lockRow ? row : String(Number(row) + rows);
    if (nextRow === '0' || nextColumn === '') return match;
    return `${before}${lockColumn}${nextColumn}${lockRow}${nextRow}`;
  }));

/** Text in double quotes, or a whole reference with its sheet: a cell, a range, whole columns or whole rows. */
const REFERENCE = /"(?:[^"]|"")*"|(?<![\p{L}\p{N}_.$'!])(?:(?:'((?:[^']|'')+)'|([\p{L}\p{N}_.]+))!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)(?![\p{L}\p{N}_.(!:])/gu;

/** Where a span of rows or columns goes when one line comes or goes; null when none of it is left. */
export const shiftSpan = (first: number, last: number, at: number, delta: 1 | -1): [number, number] | null => {
  if (delta === -1 && first === at && last === at) return null;
  return [first > at || (delta === 1 && first === at) ? first + delta : first, last >= at ? last + delta : last];
};

type ReferenceTarget = { sheet: string; axis: 'row' | 'column'; at: number; delta: 1 | -1 };

const shiftReference = (reference: string, { axis, at, delta }: ReferenceTarget): string | null => {
  const ends = reference.split(':').map((end) => {
    const [, lockColumn, column, lockRow, row] = end.match(/^(\$?)([A-Z]*)(\$?)(\d*)$/) ?? [];
    return { lockColumn, column, lockRow, row };
  });
  const lineOf = ({ column, row }: (typeof ends)[number]) => {
    if (axis === 'row') return row ? Number(row) : null;
    return column ? columnNumber(column) - 1 : null;
  };
  const first = lineOf(ends[0]);
  const last = lineOf(ends[ends.length - 1]);
  // Whole columns do not care about rows, and whole rows about columns.
  if (first === null || last === null) return reference;
  const span = shiftSpan(first, last, at, delta);
  if (!span) return null;
  return ends.map((end, index) => {
    const line = span[index === 0 ? 0 : 1];
    const place = axis === 'row' ? { column: end.column, row: String(line) } : { column: columnLetters(line + 1), row: end.row };
    return `${end.lockColumn}${place.column}${end.lockRow}${place.row}`;
  }).join(':');
};

/**
 * A defined name's references to one sheet, after a row (1-based) or column
 * (0-based) came or went. `ownSheet` says a reference with no sheet means this
 * one, as it does in a name scoped to the sheet.
 */
export const shiftSheetReferences = (formula: string, target: ReferenceTarget, ownSheet: boolean): string => formula.replace(
  REFERENCE,
  (match: string, quoted: string | undefined, bare: string | undefined, reference: string | undefined) => {
    if (!reference) return match;
    const sheet = quoted?.replace(/''/g, "'") ?? bare;
    const applies = sheet === undefined ? ownSheet : sheet.toLowerCase() === target.sheet.toLowerCase();
    if (!applies) return match;
    const next = shiftReference(reference, target);
    return next === null ? '#REF!' : `${match.slice(0, match.length - reference.length)}${next}`;
  },
);

/** `of:=SUM([.A1:.B2];[$Sheet2.C3])` as `SUM(A1:B2,Sheet2!C3)`. */
export const formulaFromOpenDocument = (formula: string): string => mapOutsideQuotes(formula.replace(/^(?:of:)?=/, ''), (part) => part
  .replace(/\[([^\]]*)\]/g, (_, inner: string) => inner
    .replace(/\$?([^.:\s]+)\.(?=\$?[A-Z])/g, (__, sheet: string) => `${sheet.replace(/^\$/, '')}!`)
    .replace(/(^|:)\./g, '$1'))
  .replace(/;/g, ','));

/** `SUM(A1:B2,Sheet2!C3)` as ODF stores it. */
export const formulaToOpenDocument = (formula: string): string => {
  const reference = /((?:'(?:[^']|'')*'|[A-Za-z_][\w.]*)!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)(?::(\$?[A-Z]{1,3}\$?[1-9]\d*))?(?![\w(])/g;
  // Quoted sheet names sit inside references, so only text in double quotes is skipped.
  const body = formula.split(/("(?:[^"]|"")*")/).map((part, index) => (index % 2 === 1
    ? part
    : part
      .replace(reference, (_, sheet: string | undefined, first: string, last: string | undefined) => {
        const owner = sheet ? `$${sheet.slice(0, -1)}` : '';
        return `[${owner}.${first}${last ? `:.${last}` : ''}]`;
      })
      .replace(/,/g, ';'))).join('');
  return `of:=${body}`;
};
