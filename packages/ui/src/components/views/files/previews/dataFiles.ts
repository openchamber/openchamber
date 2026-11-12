import type { Database } from 'sql.js/dist/sql-wasm-browser.js';

export type SqliteDatabase = Database;

type DataTable = { columns: string[]; rows: string[][]; totalRows: number };

type DataValue = string | number | bigint | boolean | null | undefined | Date | Uint8Array | DataValue[] | { [key: string]: DataValue };

/** A database or data file value as a cell shows it. */
const cellText = (value: DataValue): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return `[${value.length} B]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Object) return JSON.stringify(value, (_, item: DataValue) => (Object(item) instanceof BigInt ? String(item) : item));
  return String(value);
};

export const isSqliteFile = (bytes: Uint8Array): boolean => new TextDecoder().decode(bytes.subarray(0, 15)) === 'SQLite format 3';

export const openSqlite = async (bytes: Uint8Array): Promise<Database> => {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
    import('sql.js/dist/sql-wasm-browser.js'),
    import('sql.js/dist/sql-wasm-browser.wasm?url'),
  ]);
  const sql = await initSqlJs({ locateFile: () => wasmUrl });
  // The WAL flag asks for a sidecar file this copy in memory does not have.
  const copy = bytes.slice();
  if (copy[18] === 2) copy[18] = 1;
  if (copy[19] === 2) copy[19] = 1;
  return new sql.Database(copy);
};

/** Tables and views, in the order the file names them. */
export const sqliteTables = (database: Database): string[] => {
  const result = database.exec(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`);
  return result[0]?.values.map((row) => String(row[0])) ?? [];
};

export const quoteSqlName = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * The last result of a query, its rows past the cap only counted: a table of
 * millions never lands in memory. The database is a copy, so a query changes
 * nothing on disk.
 */
export const queryCapped = (database: Database, query: string, rowCap: number): DataTable => {
  let result: DataTable = { columns: [], rows: [], totalRows: 0 };
  for (const statement of database.iterateStatements(query)) {
    const rows: string[][] = [];
    let totalRows = 0;
    while (statement.step()) {
      totalRows += 1;
      // Without big integers an id past 2^53 would show rounded.
      if (totalRows <= rowCap) rows.push(statement.get(null, { useBigInt: true }).map(cellText));
    }
    if (totalRows > 0) result = { columns: statement.getColumnNames(), rows, totalRows };
    else if (statement.getColumnNames().length > 0) result = { columns: statement.getColumnNames(), rows, totalRows };
  }
  return result;
};

export const readParquetRows = async (bytes: Uint8Array<ArrayBuffer>, rowCap: number): Promise<DataTable> => {
  const [{ parquetMetadata, parquetReadObjects }, { compressors }] = await Promise.all([import('hyparquet'), import('hyparquet-compressors')]);
  const metadata = parquetMetadata(bytes.buffer);
  const totalRows = Number(metadata.num_rows);
  const objects = await parquetReadObjects({ file: bytes.buffer, compressors, rowEnd: Math.min(rowCap, totalRows) });
  // The schema is a flat walk of a tree; rows are keyed by the top level.
  const columns: string[] = [];
  let index = 1;
  const skip = () => {
    const children = metadata.schema[index].num_children ?? 0;
    index += 1;
    for (let child = 0; child < children; child += 1) skip();
  };
  while (index < metadata.schema.length) {
    columns.push(metadata.schema[index].name);
    skip();
  }
  return { columns, rows: objects.map((row) => columns.map((column) => cellText(row[column]))), totalRows };
};
