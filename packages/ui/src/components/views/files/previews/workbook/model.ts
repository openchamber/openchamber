import type { NumberFormat } from '@/sync/document-attachments';

export type CellKind = 'number' | 'text' | 'boolean' | 'error';

export type CellValue = { kind: CellKind; raw: string; formula?: string };

export type BookCell = CellValue & {
  row: number;
  column: number;
  display: string;
  format?: NumberFormat;
  href?: string;
  style?: string;
  shared?: string;
};

export type BookSheet = {
  name: string;
  cells: Map<string, BookCell>;
  locked: Set<string>;
  protected: boolean;
};

export type CellChange = { sheet: number; row: number; column: number; next: BookCell | null; edited: boolean };

export type StructureChange = { sheet: number; axis: 'row' | 'column'; at: number; delta: 1 | -1 };

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
  write: (changes: CellChange[]) => Promise<Uint8Array<ArrayBuffer>>;
  canRestructure: (sheet: number) => boolean;
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
