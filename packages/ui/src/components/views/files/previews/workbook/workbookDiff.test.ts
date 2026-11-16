import { describe, expect, test } from 'bun:test';

import { cellKey, type BookCell, type BookSheet, type WorkbookDocument } from './model';
import { diffWorkbooks } from './workbookDiff';

const sheet = (name: string, cells: Array<Partial<BookCell> & { row: number; column: number; raw: string }>): BookSheet => ({
  name,
  locked: new Set(),
  protected: false,
  cells: new Map(cells.map((cell) => [cellKey(cell.row, cell.column), { kind: 'number', display: cell.raw, ...cell }])),
});
const book = (...sheets: BookSheet[]): WorkbookDocument => ({ sheets, definedNames: [], date1904: false, write: async () => new Uint8Array(), canRestructure: () => false, restructure: async () => new Uint8Array() });

describe('comparing workbooks', () => {
  test('lists changed, added and removed cells in sheet order', () => {
    const before = book(sheet('A', [{ row: 1, column: 0, raw: '1' }, { row: 2, column: 0, raw: '2' }, { row: 3, column: 0, raw: '3' }]));
    const after = book(sheet('A', [{ row: 1, column: 0, raw: '1' }, { row: 2, column: 0, raw: '5' }, { row: 4, column: 1, raw: '9' }]));
    expect(diffWorkbooks(before, after)[0].cells.map((cell) => [cell.reference, cell.before, cell.after])).toEqual([['A2', '2', '5'], ['A3', '3', ''], ['B4', '', '9']]);
  });

  test('a formula that changed counts even with the same result', () => {
    const before = book(sheet('A', [{ row: 1, column: 0, raw: '2', formula: '1+1' }]));
    const after = book(sheet('A', [{ row: 1, column: 0, raw: '2', formula: '4/2' }]));
    expect(diffWorkbooks(before, after)[0].cells[0].after).toBe('2 (=4/2)');
  });

  test('no change is an empty result, and a new or a dropped sheet is named', () => {
    const one = book(sheet('A', [{ row: 1, column: 0, raw: '1' }]));
    expect(diffWorkbooks(one, one)).toEqual([]);
    const two = book(sheet('A', [{ row: 1, column: 0, raw: '1' }]), sheet('B', []));
    expect(diffWorkbooks(one, two).map((entry) => [entry.name, entry.status])).toEqual([['B', 'added']]);
    expect(diffWorkbooks(two, one).map((entry) => [entry.name, entry.status])).toEqual([['B', 'removed']]);
    expect(diffWorkbooks(null, one)[0].cells[0].reference).toBe('A1');
  });
});
