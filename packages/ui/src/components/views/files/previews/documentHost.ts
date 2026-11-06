import { noteOwnChanges, markSeen, traceChanges } from './cellTraces';
import { isSqliteFile, openSqlite, queryCapped, readParquetRows, sqliteTables, type SqliteDatabase } from './dataFiles';
import { DEFAULT_TABLE_ROW_CAP, parseDelimitedText, resolveDelimiter } from './delimitedText';
import type { BookChange, CellNote, CellPatch, DocumentCalls, SheetLayout } from './documentProtocol';
import { cellKey, type BookCell, type CellChange, type WorkbookDocument } from './workbook/model';
import { diffWorkbooks } from './workbook/workbookDiff';
import { cellInput, openWorkbookDocument, sheetGrid, WorkbookSession, type EditOutcome, type LoadEngineModel } from './workbook/workbookSession';

const CHUNK_ROWS = 5_000;
/** Past this many changed cells the viewer reads the sheet again. */
const MAX_PATCHES = 20_000;
/** Marks of outside changes cost a copy of every cell, kept for the app's lifetime. */
const MAX_TRACED_CELLS = 300_000;

const loadEngine: LoadEngineModel = async () => (await import('./workbook/ironcalc')).loadIronCalc();

type OpenBook = { session: WorkbookSession; path: string; traced: boolean };

const books = new Map<string, OpenBook>();
const databases = new Map<string, SqliteDatabase>();

type Handlers = { [Op in keyof DocumentCalls]: (
  args: DocumentCalls[Op]['args'],
  emit: (chunk: DocumentCalls[Op]['chunk']) => void,
) => Promise<DocumentCalls[Op]['result']> };

const bookOf = (id: string): OpenBook => {
  const book = books.get(id);
  if (!book) throw new Error('This workbook is no longer open');
  return book;
};

const traceEntry = (sheet: number, key: string, cell: BookCell): [string, string] => [`${sheet}:${key}`, `${cell.raw}\u0000${cell.formula ?? ''}`];

const shownCells = (document: WorkbookDocument): Map<string, string> => new Map(
  document.sheets.flatMap((sheet, index) => Array.from(sheet.cells, ([key, cell]) => traceEntry(index, key, cell))),
);

const cellCount = (document: WorkbookDocument): number => document.sheets.reduce((sum, sheet) => sum + sheet.cells.size, 0);

const noteOf = (cell: BookCell): CellNote | null => {
  const input = cellInput(cell);
  if (!cell.formula && !cell.href && input === cell.display) return null;
  return { input, formula: cell.formula, href: cell.href };
};

const patchesOf = (changes: CellChange[]): CellPatch[] | null => {
  if (changes.length > MAX_PATCHES) return null;
  return changes.map(({ sheet, row, column, next }) => ({ sheet, row, column, display: next?.display ?? '', note: next ? noteOf(next) : null }));
};

const headingRow = (cells: Iterable<BookCell>, rows: number): boolean => {
  if (rows < 2) return false;
  let count = 0;
  for (const cell of cells) {
    if (cell.row !== 1) continue;
    if (cell.kind !== 'text' || cell.formula) return false;
    count += 1;
  }
  return count > 1;
};

const edited = (book: OpenBook, outcome: EditOutcome): DocumentCalls['workbook.edit']['result'] => {
  if (outcome.status !== 'changed') return outcome;
  if (book.traced) noteOwnChanges(book.path, outcome.changes.map(({ sheet, row, column, next }) => {
    const key = cellKey(row, column);
    return next ? traceEntry(sheet, key, next) : [`${sheet}:${key}`, null];
  }));
  return { status: 'changed', previous: outcome.previous, bytes: outcome.bytes, patches: patchesOf(outcome.changes), unsupported: book.session.unsupportedFormulas };
};

const moved = (book: OpenBook, bytes: Uint8Array<ArrayBuffer>): BookChange => {
  if (book.traced) noteOwnChanges(book.path, Array.from(shownCells(book.session.document)), true);
  return { bytes, patches: null, unsupported: book.session.unsupportedFormulas };
};

const streamRows = <Row>(rows: Row[], emit: (rows: Row[]) => void) => {
  for (let start = 0; start < rows.length; start += CHUNK_ROWS) emit(rows.slice(start, start + CHUNK_ROWS));
};

const handlers: Handlers = {
  ping: async () => true,

  'workbook.open': async ({ book, path, name, bytes }) => {
    const document = await openWorkbookDocument(name, bytes);
    if (!document || document.sheets.length === 0) return null;
    return adoptWorkbook(book, path, name, bytes, document);
  },

  'workbook.layout': async ({ book, sheet, editable }, emit) => {
    const { session } = bookOf(book);
    const source = session.document.sheets[sheet];
    const { rows, ...grid } = sheetGrid(source, DEFAULT_TABLE_ROW_CAP, editable);
    for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
      const notes: Array<[string, CellNote]> = [];
      for (const row of grid.rowNumbers.slice(start, start + CHUNK_ROWS)) {
        for (let column = 0; column < grid.columnCount; column += 1) {
          const key = cellKey(row, column);
          const cell = source.cells.get(key);
          const note = cell && noteOf(cell);
          if (note) notes.push([key, note]);
        }
      }
      emit({ rows: rows.slice(start, start + CHUNK_ROWS), notes });
    }
    const layout: SheetLayout = {
      ...grid,
      headingRow: headingRow(source.cells.values(), rows.length),
      canRestructure: session.canRestructure(sheet),
      locked: Array.from(source.locked),
    };
    return layout;
  },

  'workbook.edit': async ({ book, sheet, cells }) => {
    const open = bookOf(book);
    const outcome = edited(open, await open.session.edit(sheet, cells));
    if (outcome.status !== 'changed' || !outcome.patches) return outcome;
    // A cell the edit left as it was still shows what was typed.
    const answered = new Set(outcome.patches.map(({ row, column }) => cellKey(row, column)));
    const cellsOfSheet = open.session.document.sheets[sheet].cells;
    const untouched = cells.filter(({ row, column }) => !answered.has(cellKey(row, column))).map(({ row, column }): CellPatch => {
      const cell = cellsOfSheet.get(cellKey(row, column));
      return { sheet, row, column, display: cell?.display ?? '', note: cell ? noteOf(cell) : null };
    });
    return { ...outcome, patches: [...outcome.patches, ...untouched] };
  },

  'workbook.restore': async ({ book, sheet, cells }) => {
    const open = bookOf(book);
    return edited(open, await open.session.restore(sheet, cells));
  },

  'workbook.restructure': async ({ book, change }) => {
    const open = bookOf(book);
    const { bytes, previousBytes } = await open.session.restructure(change);
    return { ...moved(open, bytes), previousBytes };
  },

  'workbook.restoreBytes': async ({ book, bytes }) => {
    const open = bookOf(book);
    const previousBytes = await open.session.restoreBytes(bytes);
    return { ...moved(open, bytes), previousBytes };
  },

  'workbook.seen': async ({ book, keys }) => Array.from(markSeen(bookOf(book).path, keys)),

  'workbook.close': async ({ book }) => {
    books.delete(book);
    return null;
  },

  'workbook.diff': async ({ name, before, after }) => {
    const [left, right] = await Promise.all([
      before ? openWorkbookDocument(name, before) : null,
      after ? openWorkbookDocument(name, after) : null,
    ]);
    return diffWorkbooks(left, right);
  },

  'sqlite.open': async ({ database, bytes }) => {
    if (!isSqliteFile(bytes)) throw new Error('Not a SQLite database');
    const opened = await openSqlite(bytes);
    databases.set(database, opened);
    return { tables: sqliteTables(opened) };
  },

  'sqlite.query': async ({ database, query, rowCap }, emit) => {
    const opened = databases.get(database);
    if (!opened) throw new Error('This database is no longer open');
    const { columns, rows, totalRows } = queryCapped(opened, query, rowCap);
    streamRows(rows, (chunk) => emit({ rows: chunk }));
    return { columns, totalRows };
  },

  'sqlite.close': async ({ database }) => {
    databases.get(database)?.close();
    databases.delete(database);
    return null;
  },

  'parquet.read': async ({ bytes, rowCap }, emit) => {
    const { columns, rows, totalRows } = await readParquetRows(bytes, rowCap);
    streamRows(rows, (chunk) => emit({ rows: chunk }));
    return { columns, totalRows };
  },

  'delimited.read': async ({ bytes, path, rowCap }, emit) => {
    const text = new TextDecoder().decode(bytes);
    const { header, rows, totalRows, columnCount } = parseDelimitedText(text, resolveDelimiter(path, text), rowCap);
    streamRows(rows, (chunk) => emit({ rows: chunk }));
    return { columns: header, totalRows, columnCount };
  },
};

/** A parsed workbook under its id, with its results filled in and its outside changes read. */
export const adoptWorkbook = async (
  book: string,
  path: string,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  document: WorkbookDocument,
): Promise<DocumentCalls['workbook.open']['result']> => {
  const session = new WorkbookSession(document, name, bytes, loadEngine);
  const traced = cellCount(document) <= MAX_TRACED_CELLS;
  books.set(book, { session, path, traced });
  await session.fillMissingResults().catch(() => false);
  return {
    sheets: session.document.sheets.map((sheet) => ({ name: sheet.name, protected: sheet.protected })),
    unseen: traced ? Array.from(traceChanges(path, shownCells(session.document))) : [],
    unsupported: session.unsupportedFormulas,
  };
};

export const handleDocumentCall = <Op extends keyof DocumentCalls>(
  op: Op,
  args: DocumentCalls[Op]['args'],
  emit: (chunk: DocumentCalls[Op]['chunk']) => void,
): Promise<DocumentCalls[Op]['result']> => handlers[op](args, emit);
