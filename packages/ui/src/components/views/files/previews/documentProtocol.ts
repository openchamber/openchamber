import type { CellRestore, CellInput } from './workbook/workbookSession';
import type { StructureChange } from './workbook/model';
import type { SheetDifference } from './workbook/workbookDiff';

export type TableChunk = { rows: string[][] };

/** `columnCount` is the widest row, for a file whose rows outrun its heading. */
export type DataTableEnd = { columns: string[]; totalRows: number; columnCount?: number };

export type SheetInfo = { name: string; protected: boolean };

/** What a cell holds beyond the text the grid shows. */
export type CellNote = { input?: string; formula?: string; href?: string };

export type SheetChunk = TableChunk & { notes: Array<[string, CellNote]> };

/** One sheet laid out for the grid; `notes` and `locked` are keyed as cells are, by file row and column. */
export type SheetLayout = {
  header: string[];
  rowNumbers: number[];
  columnCount: number;
  dataColumnCount: number;
  totalRows: number;
  headingRow: boolean;
  canRestructure: boolean;
  locked: string[];
};

export type CellPatch = { sheet: number; row: number; column: number; display: string; note: CellNote | null };

/** `patches` is null when too much moved to send cell by cell. */
export type BookChange = { bytes: Uint8Array<ArrayBuffer>; patches: CellPatch[] | null; unsupported: number };

export type BookEdit =
  | { status: 'saved-nothing' }
  | { status: 'invalid-formula' }
  | ({ status: 'changed'; previous: CellRestore[] } & BookChange);

export type BookOpened = { sheets: SheetInfo[]; unseen: string[]; unsupported: number };

/** Every call a table or workbook viewer makes, with what it takes, streams and answers. */
export type DocumentCalls = {
  ping: { args: null; chunk: never; result: true };
  'workbook.open': { args: { book: string; path: string; name: string; bytes: Uint8Array<ArrayBuffer> }; chunk: never; result: BookOpened | null };
  'workbook.layout': { args: { book: string; sheet: number; editable: boolean }; chunk: SheetChunk; result: SheetLayout };
  'workbook.edit': { args: { book: string; sheet: number; cells: CellInput[] }; chunk: never; result: BookEdit };
  'workbook.restore': { args: { book: string; sheet: number; cells: CellRestore[] }; chunk: never; result: BookEdit };
  'workbook.restructure': { args: { book: string; change: StructureChange }; chunk: never; result: BookChange & { previousBytes: Uint8Array<ArrayBuffer> } };
  'workbook.restoreBytes': { args: { book: string; bytes: Uint8Array<ArrayBuffer> }; chunk: never; result: BookChange & { previousBytes: Uint8Array<ArrayBuffer> } };
  'workbook.seen': { args: { book: string; keys: string[] }; chunk: never; result: string[] };
  'workbook.close': { args: { book: string }; chunk: never; result: null };
  'workbook.diff': { args: { name: string; before: Uint8Array<ArrayBuffer> | null; after: Uint8Array<ArrayBuffer> | null }; chunk: never; result: SheetDifference[] };
  'sqlite.open': { args: { database: string; bytes: Uint8Array<ArrayBuffer> }; chunk: never; result: { tables: string[] } };
  'sqlite.query': { args: { database: string; query: string; rowCap: number }; chunk: TableChunk; result: DataTableEnd };
  'sqlite.close': { args: { database: string }; chunk: never; result: null };
  'parquet.read': { args: { bytes: Uint8Array<ArrayBuffer>; rowCap: number }; chunk: TableChunk; result: DataTableEnd };
  'delimited.read': { args: { bytes: Uint8Array<ArrayBuffer>; delimiter: ',' | '\t'; rowCap: number }; chunk: TableChunk; result: DataTableEnd };
};

type Op = keyof DocumentCalls;
export type DocumentChunk = DocumentCalls[Op]['chunk'];
export type DocumentResult = DocumentCalls[Op]['result'];

export type DocumentRequest = { id: number; op: Op; args: DocumentCalls[Op]['args'] };

export type DocumentResponse =
  | { id: number; type: 'chunk'; value: DocumentChunk }
  | { id: number; type: 'done'; value: DocumentResult }
  | { id: number; type: 'error'; message: string };
