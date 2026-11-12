import type { NumberFormat } from '@/sync/document-attachments';

export type CellKind = 'number' | 'text' | 'boolean' | 'error';

/** What a cell holds. `raw` is the stored value: digits for a number, `TRUE` or `FALSE`, the text or the error code. */
export type CellValue = { kind: CellKind; raw: string; formula?: string };

export type BookCell = CellValue & {
  row: number;
  column: number;
  /** The value as the sheet shows it. */
  display: string;
  format?: NumberFormat;
  href?: string;
  /** The format's own style reference in the file, kept through a write. */
  style?: string;
  /** Part of a shared formula in the file. */
  shared?: string;
};

export type BookSheet = {
  name: string;
  cells: Map<string, BookCell>;
  /** Cells the file's own structure forbids changing: parts of merged areas and array formulas, table headings. */
  locked: Set<string>;
  /** The whole sheet is protected in the file. */
  protected: boolean;
};

/** A change to one cell; `next` is null for an emptied cell. `edited` marks what the user typed, the rest was recalculated. */
export type CellChange = { sheet: number; row: number; column: number; next: BookCell | null; edited: boolean };

/** One row or column added before `at`, or `at` removed. Rows count from 1 and columns from 0, as cells do. */
export type StructureChange = { sheet: number; axis: 'row' | 'column'; at: number; delta: 1 | -1 };

/** Where a cell lands after a structure change; null when its row or column went away. */
export const movedCell = ({ axis, at, delta }: StructureChange, row: number, column: number): { row: number; column: number } | null => {
  const line = axis === 'row' ? row : column;
  if (delta === -1 && line === at) return null;
  const next = line >= at + (delta === -1 ? 1 : 0) ? line + delta : line;
  return axis === 'row' ? { row: next, column } : { row, column: next };
};

export type WorkbookDocument = {
  sheets: BookSheet[];
  definedNames: Array<{ name: string; scope: number | null; formula: string }>;
  date1904: boolean;
  /** The file's bytes with these changes in place and everything else as it was. */
  write: (changes: CellChange[]) => Promise<Uint8Array<ArrayBuffer>>;
  /** Parts tied to cell addresses that a structure change would leave behind rule it out. */
  canRestructure: (sheet: number) => boolean;
  /** Moves the cells and the defined names with them, then applies `changes`, which name cells where they end up. */
  restructure: (change: StructureChange, changes: CellChange[]) => Promise<Uint8Array<ArrayBuffer>>;
};

export const cellKey = (row: number, column: number): string => `${row}:${column}`;

export const rangeBounds = (reference: string): { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number } | null => {
  const match = reference.replace(/\$/g, '').match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) return null;
  const column = (name: string) => {
    let result = 0;
    for (const character of name.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
    return result - 1;
  };
  const firstColumn = column(match[1]);
  const firstRow = Number(match[2]);
  return { firstRow, firstColumn, lastRow: match[4] ? Number(match[4]) : firstRow, lastColumn: match[3] ? column(match[3]) : firstColumn };
};
