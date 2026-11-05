import { columnName } from '@/sync/document-attachments';
import { getFileExtension } from '@/lib/toolHelpers';
import { FormulaEngine, type EngineModel } from './formulaEngine';
import { cellKey, movedCell, type BookCell, type BookSheet, type CellChange, type CellValue, type StructureChange, type WorkbookDocument } from './model';
import { openOdsDocument } from './odsDocument';
import { openXlsxDocument } from './xlsxDocument';

export const openWorkbookDocument = (name: string, bytes: Uint8Array): Promise<WorkbookDocument | null> => (
  getFileExtension(name) === 'xlsx' ? openXlsxDocument(bytes) : openOdsDocument(bytes)
);

/** Rows and columns laid out for a grid, in file order. */
type SheetGrid = {
  header: string[];
  rowNumbers: number[];
  rows: string[][];
  columnCount: number;
  /** Columns with a value, without the spare one. */
  dataColumnCount: number;
  /** Rows with a value in the file, including the ones past the cap. */
  totalRows: number;
};

const MAX_GRID_COLUMNS = 256;

/**
 * One spare row and column follow the data, so a sheet can grow. Gaps show as
 * empty rows while the sheet fits the cap; past it only rows with values do.
 */
export const sheetGrid = (sheet: BookSheet, rowCap: number, editable: boolean): SheetGrid => {
  const filled = new Set<number>();
  let lastColumn = -1;
  let lastRow = 0;
  for (const cell of sheet.cells.values()) {
    filled.add(cell.row);
    if (cell.column > lastColumn) lastColumn = cell.column;
    if (cell.row > lastRow) lastRow = cell.row;
  }
  const spare = editable ? 1 : 0;
  const columnCount = Math.min(MAX_GRID_COLUMNS, lastColumn + 1 + spare);
  const ordered = lastRow + spare <= rowCap
    ? Array.from({ length: lastRow + spare }, (_, index) => index + 1)
    : Array.from(filled).sort((left, right) => left - right).slice(0, rowCap);
  return {
    header: Array.from({ length: columnCount }, (_, column) => columnName(column)),
    rowNumbers: ordered,
    rows: ordered.map((row) => Array.from({ length: columnCount }, (_, column) => sheet.cells.get(cellKey(row, column))?.display ?? '')),
    columnCount,
    dataColumnCount: lastColumn + 1,
    totalRows: Math.max(filled.size, ordered.length - spare),
  };
};

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const NUMBER_INPUT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

const dateInputSerial = (input: string, date1904: boolean): number | null => {
  const parts = input.match(DATE_INPUT);
  if (!parts) return null;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = parts;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (Number.isNaN(time)) return null;
  const serial = time / 86_400_000 + 25569;
  return date1904 ? serial - 1462 : serial;
};

/** What the user typed, read the way a spreadsheet reads it. */
export const parseCellInput = (input: string, existing: BookCell | undefined, date1904: boolean): CellValue | null => {
  const text = input.trim();
  if (input === '') return null;
  if (text.startsWith('=') && text.length > 1) return { kind: 'text', raw: '', formula: text.slice(1) };
  if (existing?.format?.isDate) {
    const serial = dateInputSerial(text, date1904);
    if (serial !== null) return { kind: 'number', raw: String(serial) };
  }
  if (NUMBER_INPUT.test(text)) return { kind: 'number', raw: String(Number(text)) };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(text)) return { kind: 'number', raw: String(Number(text.slice(0, -1)) / 100) };
  if (/^(?:true|false)$/i.test(text)) return { kind: 'boolean', raw: text.toUpperCase() };
  return { kind: 'text', raw: input };
};

const displayOf = (cell: CellValue, previous: BookCell | undefined): string => {
  if (cell.kind !== 'number') return cell.raw;
  const value = Number(cell.raw);
  if (previous?.format) return previous.format(value);
  // ODF stores the shown text, so a new result keeps the decimals it had.
  const percent = previous?.display.endsWith('%');
  if (percent) return `${(value * 100).toFixed(previous?.display.match(/\.(\d+)%$/)?.[1].length ?? 0)}%`;
  return cell.raw;
};

/** What the editor offers for a cell: its formula, or the value in a form it reads back. */
export const cellInput = (cell: BookCell | undefined): string => {
  if (!cell) return '';
  if (cell.formula) return `=${cell.formula}`;
  return cell.format?.isDate || cell.kind !== 'number' ? cell.display : cell.raw;
};

const sameValue = (left: BookCell, right: CellValue | BookCell): boolean => left.kind === right.kind && left.raw === right.raw && (left.formula ?? '') === (right.formula ?? '');

export type CellInput = { row: number; column: number; input: string };
export type CellRestore = { row: number; column: number; value: CellValue | null };

export type EditOutcome =
  | { status: 'saved-nothing' }
  | { status: 'invalid-formula' }
  /** `previous` puts the cell back exactly: typing it again could turn the text `00123` into a number. */
  | { status: 'changed'; bytes: Uint8Array<ArrayBuffer>; previous: CellRestore[]; changes: CellChange[] };

export type LoadEngineModel = () => Promise<new (name: string, locale: string, timezone: string, language: string) => EngineModel>;

/** One open workbook: what it holds now, its engine once needed, and every write proved against a fresh read. */
export class WorkbookSession {
  private engine: FormulaEngine | null = null;

  constructor(
    public document: WorkbookDocument,
    private readonly name: string,
    private bytes: Uint8Array<ArrayBuffer>,
    private readonly loadModel: LoadEngineModel,
  ) {}

  get hasFormulas(): boolean {
    return this.document.sheets.some((sheet) => Array.from(sheet.cells.values()).some((cell) => cell.formula));
  }

  get unsupportedFormulas(): number {
    return this.engine?.unsupported.size ?? 0;
  }

  isLocked(sheet: number, row: number, column: number): boolean {
    const book = this.document.sheets[sheet];
    return book.protected || book.locked.has(cellKey(row, column));
  }

  private async ensureEngine(): Promise<FormulaEngine> {
    if (!this.engine) {
      const ModelClass = await this.loadModel();
      this.engine = new FormulaEngine(new ModelClass('workbook', 'en', 'UTC', 'en'), this.document);
    }
    return this.engine;
  }

  private build(row: number, column: number, value: CellValue, previous: BookCell | undefined): BookCell {
    const { display: _display, ...kept } = previous ?? { row, column, display: '' };
    return { ...kept, ...value, formula: value.formula, row, column, display: displayOf(value, previous) };
  }

  /**
   * Generators such as openpyxl write formulas with no stored result, and a
   * spreadsheet app fills it in on open. Those cells are computed here the same
   * way; returns whether any cell changed.
   */
  async fillMissingResults(): Promise<boolean> {
    const missing = this.document.sheets.flatMap((sheet, index) => Array.from(sheet.cells.values())
      .filter((cell) => cell.formula && cell.raw === '')
      .map((cell) => ({ sheet: index, cell })));
    if (missing.length === 0) return false;
    const engine = await this.ensureEngine();
    for (const { sheet, cell } of missing) {
      const result = engine.result(sheet, cell.row, cell.column);
      if (!result) continue;
      Object.assign(cell, { kind: result.kind, raw: result.raw, display: displayOf(result, cell) });
    }
    return true;
  }

  /** What was typed into these cells, as one step. */
  async edit(sheet: number, cells: CellInput[]): Promise<EditOutcome> {
    const book = this.document.sheets[sheet];
    const parsed = cells.flatMap(({ row, column, input }) => {
      const previous = book.cells.get(cellKey(row, column));
      const value = parseCellInput(input, previous, this.document.date1904);
      if (!value && !previous) return [];
      if (value && previous && !value.formula && sameValue(previous, value)) return [];
      return [{ row, column, value }];
    });
    if (parsed.length === 0) return { status: 'saved-nothing' };
    return this.put(sheet, parsed);
  }

  /** Puts back what `edit` reported as `previous`. */
  restore(sheet: number, cells: CellRestore[]): Promise<EditOutcome> {
    return this.put(sheet, cells);
  }

  private async put(sheet: number, items: CellRestore[]): Promise<EditOutcome> {
    const book = this.document.sheets[sheet];
    const previous: CellRestore[] = items.map(({ row, column }) => {
      const cell = book.cells.get(cellKey(row, column));
      return { row, column, value: cell ? { kind: cell.kind, raw: cell.raw, formula: cell.formula } : null };
    });
    const changes = new Map<string, CellChange>();
    const place = (target: number, row: number, column: number) => `${target}:${cellKey(row, column)}`;
    const usesEngine = this.hasFormulas || items.some((item) => item.value?.formula);
    const engine = usesEngine ? await this.ensureEngine() : null;
    for (const { row, column, value: input } of items) {
      const cell = { sheet, row, column };
      const before = book.cells.get(cellKey(row, column));
      let value = input;
      if (!engine) {
        changes.set(place(sheet, row, column), { ...cell, next: value ? this.build(row, column, value, before) : null, edited: true });
        continue;
      }
      if (value?.formula) {
        const checked = engine.check(cell, `=${value.formula}`);
        if (checked.broken) {
          // Cells of this batch already went in; the next edit starts clean.
          this.engine = null;
          return { status: 'invalid-formula' };
        }
        value = { ...value, formula: checked.formula };
      }
      const results = engine.set(cell, value);
      const own = results.find((result) => result.sheet === sheet && result.row === row && result.column === column);
      if (value?.formula && own) value = { kind: own.kind, raw: own.raw, formula: value.formula };
      else if (value?.formula && !value.raw) value = { ...value, kind: before?.kind ?? 'number', raw: before?.raw ?? '0' };
      changes.set(place(sheet, row, column), { ...cell, next: value ? this.build(row, column, value, before) : null, edited: true });
      for (const result of results) {
        if (result === own) continue;
        const key = place(result.sheet, result.row, result.column);
        const pending = changes.get(key);
        const target = pending?.next ?? this.document.sheets[result.sheet].cells.get(cellKey(result.row, result.column));
        if (!target) continue;
        changes.set(key, {
          sheet: result.sheet,
          row: result.row,
          column: result.column,
          next: this.build(result.row, result.column, { ...result, formula: target.formula }, target),
          edited: pending?.edited ?? false,
        });
      }
    }

    const list = Array.from(changes.values());
    const next = await this.document.write(list);
    await this.prove(next, list);
    for (const change of list) {
      const cells = this.document.sheets[change.sheet].cells;
      const changeKey = cellKey(change.row, change.column);
      if (change.next) cells.set(changeKey, change.next);
      else cells.delete(changeKey);
    }
    this.bytes = next;
    return { status: 'changed', bytes: next, previous, changes: list };
  }

  canRestructure(sheet: number): boolean {
    return !this.document.sheets[sheet].protected && this.document.sheets[sheet].locked.size === 0 && this.document.canRestructure(sheet);
  }

  /** Adds or removes a row or column; `previousBytes` undoes it. */
  async restructure(change: StructureChange): Promise<{ bytes: Uint8Array<ArrayBuffer>; previousBytes: Uint8Array<ArrayBuffer> }> {
    const engine = await this.ensureEngine();
    const unsupported = (sheet: number, cell: BookCell) => engine.isUnsupported(sheet, cell.row, cell.column);
    const held = this.document.sheets.map((sheet, index) => Array.from(sheet.cells.values()).filter((cell) => cell.formula && unsupported(index, cell)));
    engine.restructure(change);
    const changes: CellChange[] = [];
    const expected = this.document.sheets.map((sheet, index) => {
      const cells = new Map<string, BookCell>();
      for (const cell of sheet.cells.values()) {
        const place = index === change.sheet ? movedCell(change, cell.row, cell.column) : { row: cell.row, column: cell.column };
        if (!place) continue;
        let next: BookCell = { ...cell, ...place };
        if (cell.formula) {
          const { formula, value } = engine.formulaAt({ sheet: index, ...place });
          // What the engine cannot compute keeps the file's result.
          const result = held[index].includes(cell) ? { kind: cell.kind, raw: cell.raw } : value;
          next = { ...next, ...result, formula, display: displayOf(result, cell), shared: undefined };
          if (next.formula !== cell.formula || next.raw !== cell.raw || next.kind !== cell.kind || cell.shared !== undefined) {
            changes.push({ sheet: index, ...place, next, edited: true });
          }
        }
        cells.set(cellKey(place.row, place.column), next);
      }
      return cells;
    });
    const bytes = await this.document.restructure(change, changes);
    const reread = await openWorkbookDocument(this.name, bytes);
    const failed = !reread || expected.some((cells, index) => {
      const stored = reread.sheets[index]?.cells;
      if (!stored || stored.size !== cells.size) return true;
      for (const [key, cell] of cells) {
        const found = stored.get(key);
        if (!found || (found.formula ?? '') !== (cell.formula ?? '') || (found.raw !== cell.raw && !(cell.formula && found.raw === ''))) return true;
      }
      return false;
    });
    this.engine = null;
    if (!reread || failed) {
      const restored = await openWorkbookDocument(this.name, this.bytes);
      if (restored) this.document = restored;
      throw new Error('The changed workbook did not read back');
    }
    const previousBytes = this.bytes;
    this.document = reread;
    this.bytes = bytes;
    await this.fillMissingResults();
    return { bytes, previousBytes };
  }

  /** Back to an earlier state of the file, for undoing a structure change. */
  async restoreBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const document = await openWorkbookDocument(this.name, bytes);
    if (!document) throw new Error('The earlier workbook did not read back');
    const previousBytes = this.bytes;
    this.document = document;
    this.bytes = bytes;
    this.engine = null;
    await this.fillMissingResults();
    return previousBytes;
  }

  /** A write that cannot be read back is never handed over: the open document returns to the last good bytes. */
  private async prove(next: Uint8Array, changes: CellChange[]): Promise<void> {
    const reread = await openWorkbookDocument(this.name, next);
    const changedCells = new Set(changes.map((change) => `${change.sheet}:${cellKey(change.row, change.column)}`));
    const failed = !reread || changes.some((change) => {
      const cell = reread.sheets[change.sheet]?.cells.get(cellKey(change.row, change.column));
      if (!change.next) return Boolean(cell && (cell.raw || cell.formula));
      return !cell || !sameValue(cell, change.next);
    }) || this.document.sheets.some((sheet, index) => {
      // Every other cell must come back as it was. A result computed here for a
      // formula the file stores without one reads back empty, and that is fine.
      for (const [key, cell] of sheet.cells) {
        if (changedCells.has(`${index}:${key}`)) continue;
        const stored = reread.sheets[index]?.cells.get(key);
        if (!stored || (stored.formula ?? '') !== (cell.formula ?? '')) return true;
        if (stored.raw !== cell.raw && !(cell.formula && stored.raw === '')) return true;
      }
      return false;
    });
    if (!failed) return;
    const restored = await openWorkbookDocument(this.name, this.bytes);
    if (restored) this.document = restored;
    this.engine = null;
    throw new Error('The edited workbook did not read back');
  }

  get currentBytes(): Uint8Array<ArrayBuffer> {
    return this.bytes;
  }
}
