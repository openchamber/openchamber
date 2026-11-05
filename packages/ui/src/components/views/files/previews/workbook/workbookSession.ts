import { columnName } from '@/sync/document-attachments';
import { getFileExtension } from '@/lib/toolHelpers';
import { FormulaEngine, type EngineModel } from './formulaEngine';
import { cellKey, type BookCell, type BookSheet, type CellChange, type CellValue, type WorkbookDocument } from './model';
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
  for (const cell of sheet.cells.values()) {
    filled.add(cell.row);
    if (cell.column > lastColumn) lastColumn = cell.column;
  }
  const lastRow = Math.max(0, ...filled);
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

export type EditOutcome =
  | { status: 'saved-nothing' }
  | { status: 'invalid-formula' }
  /** `previous` puts the cell back exactly: typing it again could turn the text `00123` into a number. */
  | { status: 'changed'; bytes: Uint8Array<ArrayBuffer>; previous: CellValue | null };

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

  private build(sheet: number, row: number, column: number, value: CellValue, previous: BookCell | undefined): BookCell {
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

  async edit(sheet: number, row: number, column: number, input: string): Promise<EditOutcome> {
    const book = this.document.sheets[sheet];
    const key = cellKey(row, column);
    const previous = book.cells.get(key);
    const parsed = parseCellInput(input, previous, this.document.date1904);
    if (!parsed && !previous) return { status: 'saved-nothing' };
    if (parsed && previous && !parsed.formula && sameValue(previous, parsed)) return { status: 'saved-nothing' };
    return this.put(sheet, row, column, parsed);
  }

  /** Puts back what `edit` reported as `previous`. */
  restore(sheet: number, row: number, column: number, value: CellValue | null): Promise<EditOutcome> {
    return this.put(sheet, row, column, value);
  }

  private async put(sheet: number, row: number, column: number, parsed: CellValue | null): Promise<EditOutcome> {
    const previous = this.document.sheets[sheet].cells.get(cellKey(row, column));
    const before: CellValue | null = previous ? { kind: previous.kind, raw: previous.raw, formula: previous.formula } : null;
    const changes: CellChange[] = [];
    const cell = { sheet, row, column };
    if (parsed?.formula || this.hasFormulas) {
      const engine = await this.ensureEngine();
      let value = parsed;
      if (parsed?.formula) {
        const checked = engine.check(cell, `=${parsed.formula}`);
        if (checked.broken) return { status: 'invalid-formula' };
        value = { ...parsed, formula: checked.formula };
      }
      const results = engine.set(cell, value);
      const own = results.find((result) => result.sheet === sheet && result.row === row && result.column === column);
      if (value?.formula && !own) value = { ...value, kind: parsed?.raw ? parsed.kind : previous?.kind ?? 'number', raw: parsed?.raw || (previous?.raw ?? '0') };
      else if (value?.formula && own) value = { kind: own.kind, raw: own.raw, formula: value.formula };
      changes.push({ ...cell, next: value ? this.build(sheet, row, column, value, previous) : null, edited: true });
      for (const result of results) {
        if (result === own) continue;
        const target = this.document.sheets[result.sheet].cells.get(cellKey(result.row, result.column));
        if (!target) continue;
        changes.push({ sheet: result.sheet, row: result.row, column: result.column, next: this.build(result.sheet, result.row, result.column, { ...result, formula: target.formula }, target), edited: false });
      }
    } else {
      changes.push({ ...cell, next: parsed ? this.build(sheet, row, column, parsed, previous) : null, edited: true });
    }

    const next = await this.document.write(changes);
    await this.prove(next, changes);
    for (const change of changes) {
      const cells = this.document.sheets[change.sheet].cells;
      const changeKey = cellKey(change.row, change.column);
      if (change.next) cells.set(changeKey, change.next);
      else cells.delete(changeKey);
    }
    this.bytes = next;
    return { status: 'changed', bytes: next, previous: before };
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
