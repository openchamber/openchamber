import { z } from 'zod';

const STORAGE_KEY = 'openchamber.columnWidths.v1';
const MAX_TABLES = 300;

export type ColumnWidths = Readonly<Record<number, number>>;

const storedTables = z.record(z.string(), z.record(z.string(), z.number().positive()));

const readAll = (): Record<string, ColumnWidths> => {
  try {
    return storedTables.parse(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return {};
  }
};

/** The widths the user gave a table's columns. `table` names it: a file, plus a sheet or the table's headings. */
export const loadColumnWidths = (table: string): ColumnWidths => readAll()[table] ?? {};

export const saveColumnWidths = (table: string, widths: ColumnWidths): void => {
  const tables = readAll();
  // The newest table goes last, so the oldest ones fall off the front.
  delete tables[table];
  if (Object.keys(widths).length > 0) tables[table] = widths;
  const kept = Object.entries(tables).slice(-MAX_TABLES);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or off: the widths last until the file closes.
  }
};
