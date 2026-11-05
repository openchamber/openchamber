import type { Model } from '@ironcalc/wasm';

import { cellKey, type BookCell, type CellKind, type CellValue, type WorkbookDocument } from './model';

export type EngineModel = Pick<Model,
  'evaluate' | 'getCellContent' | 'getCellType' | 'getFormattedCellValue' | 'newDefinedName' | 'newSheet'
  | 'pauseEvaluation' | 'renameSheet' | 'resumeEvaluation' | 'setUserInput' | 'updateRangeStyle'>;

type EngineCell = { sheet: number; row: number; column: number };
export type Recalculated = EngineCell & CellValue;

// The engine hands out text only. Scientific notation keeps the 15 digits a
// spreadsheet stores, and it stops the engine styling a result by its function
// (`$` on PMT, a date on DATE).
const FULL_PRECISION = '0.00000000000000E+00';
const TYPE_NUMBER = 1;
const TYPE_BOOLEAN = 4;
const TYPE_ERROR = 16;

const inputOf = (cell: CellValue): string => {
  if (cell.formula) return `=${cell.formula}`;
  // The apostrophe keeps `00123` or `TRUE` in a text cell from turning into a value.
  return cell.kind === 'text' || cell.kind === 'error' ? `'${cell.raw}` : cell.raw;
};

/**
 * The workbook's formulas, recalculated inside the app. A function the engine
 * lacks shows an error here while the file holds a good result; such a result
 * stays as the file has it, and the spreadsheet app recalculates it on open.
 */
export class FormulaEngine {
  private readonly results = new Map<string, Recalculated>();
  /** Formula cells whose stored result this engine cannot reproduce. */
  readonly unsupported = new Set<string>();

  constructor(private readonly model: EngineModel, private readonly document: WorkbookDocument) {
    model.pauseEvaluation();
    document.sheets.forEach((sheet, index) => {
      if (index > 0) model.newSheet();
      try {
        model.renameSheet(index, sheet.name);
      } catch {
        // A name the engine refuses only breaks references to that sheet.
      }
    });
    for (const { name, scope, formula } of document.definedNames) {
      try {
        model.newDefinedName(name, scope, formula);
      } catch {
        // Print areas and other names outside its grammar.
      }
    }
    document.sheets.forEach((sheet, index) => {
      const formulas: BookCell[] = [];
      for (const cell of sheet.cells.values()) {
        if (cell.formula) formulas.push(cell);
        else model.setUserInput(index, cell.row, cell.column + 1, inputOf(cell));
      }
      for (const cell of formulas) {
        model.setUserInput(index, cell.row, cell.column + 1, inputOf(cell));
        this.useFullPrecision({ sheet: index, row: cell.row, column: cell.column });
      }
    });
    this.evaluate();
    document.sheets.forEach((sheet, index) => {
      for (const cell of sheet.cells.values()) {
        if (!cell.formula) continue;
        const value = this.read({ sheet: index, row: cell.row, column: cell.column });
        this.results.set(this.key(index, cell.row, cell.column), value);
        if (value.kind === 'error' && cell.kind !== 'error' && cell.raw !== '') this.unsupported.add(this.key(index, cell.row, cell.column));
      }
    });
  }

  private key(sheet: number, row: number, column: number): string {
    return `${sheet}:${cellKey(row, column)}`;
  }

  private useFullPrecision({ sheet, row, column }: EngineCell): void {
    this.model.updateRangeStyle({ sheet, row, column: column + 1, width: 1, height: 1 }, 'num_fmt', FULL_PRECISION);
  }

  private evaluate(): void {
    this.model.resumeEvaluation();
    this.model.evaluate();
    this.model.pauseEvaluation();
  }

  private read(cell: EngineCell): Recalculated {
    const text = this.model.getFormattedCellValue(cell.sheet, cell.row, cell.column + 1);
    const type = this.model.getCellType(cell.sheet, cell.row, cell.column + 1);
    const kind: CellKind = type === TYPE_NUMBER ? 'number' : type === TYPE_BOOLEAN ? 'boolean' : type === TYPE_ERROR ? 'error' : 'text';
    return { ...cell, kind, raw: kind === 'number' ? String(Number(text)) : text };
  }

  /** The computed result of a formula cell. */
  result(sheet: number, row: number, column: number): Recalculated | undefined {
    return this.results.get(this.key(sheet, row, column));
  }

  /** `#ERROR!` means the engine could not read the formula at all. */
  check(cell: EngineCell, input: string) {
    const { sheet, row, column } = cell;
    const before = this.model.getCellContent(sheet, row, column + 1);
    this.model.setUserInput(sheet, row, column + 1, input);
    const content = this.model.getCellContent(sheet, row, column + 1);
    this.evaluate();
    const broken = this.model.getFormattedCellValue(sheet, row, column + 1) === '#ERROR!';
    if (broken) {
      this.model.setUserInput(sheet, row, column + 1, before);
      this.evaluate();
    }
    return { formula: content.replace(/^=/, ''), broken };
  }

  /** Puts a value or formula into a cell and returns every formula result that changed, the cell's own included. */
  set(cell: EngineCell, next: CellValue | null): Recalculated[] {
    const { sheet, row, column } = cell;
    const key = this.key(sheet, row, column);
    this.model.setUserInput(sheet, row, column + 1, next ? inputOf(next) : '');
    if (next?.formula) this.useFullPrecision(cell);
    else {
      this.results.delete(key);
      this.unsupported.delete(key);
    }
    this.evaluate();
    if (next?.formula) this.results.set(key, { ...cell, kind: 'text', raw: '\0' });
    const changed: Recalculated[] = [];
    for (const [resultKey, previous] of this.results) {
      const value = this.read(previous);
      if (value.kind === previous.kind && value.raw === previous.raw) continue;
      this.results.set(resultKey, value);
      // Only a cell the engine can compute takes a new result.
      if (value.kind !== 'error' || !this.unsupported.has(resultKey)) changed.push(value);
    }
    return changed;
  }
}
