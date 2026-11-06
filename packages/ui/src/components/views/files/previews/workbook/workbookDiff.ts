import { columnName } from '@/sync/document-attachments';
import { type BookCell, type WorkbookDocument } from './model';

export type CellDifference = { reference: string; row: number; column: number; before: string; after: string };
export type SheetDifference = { name: string; cells: CellDifference[]; status: 'changed' | 'added' | 'removed' };

const shown = (cell: BookCell | undefined): string => {
  if (!cell) return '';
  return cell.formula ? `${cell.display} (=${cell.formula})` : cell.display;
};

const sameCell = (left: BookCell | undefined, right: BookCell | undefined): boolean => (
  (left?.raw ?? '') === (right?.raw ?? '') && (left?.formula ?? '') === (right?.formula ?? '') && (left?.kind ?? 'text') === (right?.kind ?? 'text')
);

/** Cell by cell, sheets matched by name. A sheet only one side has lists all its cells. */
export const diffWorkbooks = (before: WorkbookDocument | null, after: WorkbookDocument | null): SheetDifference[] => {
  const older = new Map(before?.sheets.map((sheet) => [sheet.name, sheet]));
  const newer = new Map(after?.sheets.map((sheet) => [sheet.name, sheet]));
  const names = [...(after?.sheets ?? []).map((sheet) => sheet.name), ...(before?.sheets ?? []).map((sheet) => sheet.name).filter((name) => !newer.has(name))];
  return names.flatMap((name): SheetDifference[] => {
    const left = older.get(name)?.cells ?? new Map<string, BookCell>();
    const right = newer.get(name)?.cells ?? new Map<string, BookCell>();
    const cells = Array.from(new Set([...left.keys(), ...right.keys()])).flatMap((key) => {
      const first = left.get(key);
      const second = right.get(key);
      const cell = second ?? first;
      if (!cell || sameCell(first, second)) return [];
      return [{ reference: `${columnName(cell.column)}${cell.row}`, row: cell.row, column: cell.column, before: shown(first), after: shown(second) }];
    }).sort((a, b) => a.row - b.row || a.column - b.column);
    const status = !older.has(name) ? 'added' : !newer.has(name) ? 'removed' : 'changed';
    return cells.length > 0 || status !== 'changed' ? [{ name, cells, status }] : [];
  });
};
