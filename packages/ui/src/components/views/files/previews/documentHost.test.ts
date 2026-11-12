import { describe, expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';

import { handleDocumentCall } from './documentHost';
import { patchSheetView, WorkbookBook, type SheetView } from './documentClient';
import type { DocumentCalls } from './documentProtocol';
import { queryCapped } from './dataFiles';

const call = <Op extends keyof DocumentCalls>(op: Op, args: DocumentCalls[Op]['args'], onChunk?: (chunk: DocumentCalls[Op]['chunk']) => void) => (
  handleDocumentCall(op, args, (chunk) => onChunk?.(chunk))
);

const xlsx = (sheet: string): Uint8Array<ArrayBuffer> => new Uint8Array(zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  '_rels/.rels': strToU8('<Relationships/>'),
  'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
}));

const open = async (id: string, sheet: string) => {
  const bytes = xlsx(sheet);
  const opened = await call('workbook.open', { book: id, path: `/${id}.xlsx`, name: 'a.xlsx', bytes });
  if (!opened) throw new Error('not opened');
  return new WorkbookBook(call, id, opened);
};

const view = (overrides: Partial<SheetView> = {}): SheetView => ({
  sheet: 0,
  header: ['A', 'B', 'C'],
  rowNumbers: [1, 2, 3],
  rows: [['1', '2', ''], ['3', '4', ''], ['', '', '']],
  columnCount: 3,
  dataColumnCount: 2,
  totalRows: 2,
  headingRow: false,
  canRestructure: true,
  locked: [],
  lockedCells: new Set(),
  notes: new Map(),
  ...overrides,
});

describe('a workbook behind the host', () => {
  test('a sheet arrives laid out, with what its cells hold beyond their text', async () => {
    const book = await open('layout', '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*2</f><v>4</v></c></row>');
    const shown = await book.layout(0, true);
    expect(shown.rows[0].slice(0, 2)).toEqual(['2', '4']);
    expect(shown.notes.get('1:1')).toMatchObject({ formula: 'A1*2', input: '=A1*2' });
    expect(shown.notes.has('1:0')).toBe(false);
  });

  test('a large row count does not overflow the stack of a worker', async () => {
    const rows = Array.from({ length: 200_000 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>1</v></c></row>`).join('');
    const book = await open('long', rows);
    const shown = await book.layout(0, false);
    expect(shown.totalRows).toBe(200_000);
    expect(shown.rows.length).toBe(100_000);
  });

  test('an edit answers with the cells it changed and how to put them back', async () => {
    const book = await open('edit', '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>9</v></c></row>');
    const outcome = await book.edit(0, [{ row: 1, column: 1, input: '10' }]);
    if (outcome.status !== 'changed') throw new Error(outcome.status);
    expect(outcome.patches).toEqual([{ sheet: 0, row: 1, column: 1, display: '10', note: null }]);
    expect(outcome.previous[0].value?.raw).toBe('9');
  });

  test('a closed book says so', async () => {
    const book = await open('closed', '<row r="1"><c r="A1"><v>2</v></c></row>');
    book.close();
    await expect(book.layout(0, false)).rejects.toThrow('no longer open');
  });
});

describe('changed cells on a laid out sheet', () => {
  test('a change lands in a copy of its row, and rows nobody touched stay the same object', () => {
    const before = view();
    const after = patchSheetView(before, [{ sheet: 0, row: 2, column: 1, display: '9', note: { formula: 'A2' } }]);
    expect(after?.rows[1]).toEqual(['3', '9', '']);
    expect(before.rows[1][1]).toBe('4');
    expect(after?.rows[0]).toBe(before.rows[0]);
    expect(after?.notes.get('2:1')).toEqual({ formula: 'A2' });
  });

  test('a change on another sheet is not this sheet', () => {
    expect(patchSheetView(view(), [{ sheet: 1, row: 2, column: 1, display: '9', note: null }])?.rows[1][1]).toBe('4');
  });

  test('a cell outside the grid or on its spare edge asks for a new layout', () => {
    expect(patchSheetView(view(), [{ sheet: 0, row: 9, column: 0, display: '9', note: null }])).toBeNull();
    expect(patchSheetView(view(), [{ sheet: 0, row: 3, column: 0, display: '9', note: null }])).toBeNull();
    expect(patchSheetView(view(), [{ sheet: 0, row: 1, column: 2, display: '9', note: null }])).toBeNull();
    expect(patchSheetView(view(), [{ sheet: 0, row: 3, column: 0, display: '9', note: null }], true)?.rows[2][0]).toBe('9');
  });
});

describe('a capped query', () => {
  const statement = (rows: number, names: string[]) => {
    let left = rows;
    return { step: () => (left -= 1) >= 0, get: () => [left], getColumnNames: () => names };
  };
  // SAFETY: the query reads only these members of a database and its statements.
  const database = (statements: Array<ReturnType<typeof statement>>) => ({ iterateStatements: () => statements[Symbol.iterator](), exec: () => [], close: () => undefined }) as never;

  test('rows past the cap are counted, not kept', () => {
    const result = queryCapped(database([statement(5, ['a'])]), 'q', 2);
    expect(result.rows.length).toBe(2);
    expect(result.totalRows).toBe(5);
  });

  test('the last statement with a result wins', () => {
    expect(queryCapped(database([statement(1, ['a']), statement(0, []), statement(1, ['b'])]), 'q', 9).columns).toEqual(['b']);
    expect(queryCapped(database([statement(1, ['a']), statement(0, [])]), 'q', 9).columns).toEqual(['a']);
  });
});
