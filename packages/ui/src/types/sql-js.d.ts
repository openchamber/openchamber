declare module 'sql.js/dist/sql-wasm-browser.js' {
  type SqlValue = string | number | bigint | Uint8Array | null;
  export type QueryResult = { columns: string[]; values: SqlValue[][] };
  export type Statement = {
    step(): boolean;
    get(params: null, config: { useBigInt: boolean }): SqlValue[];
    getColumnNames(): string[];
  };
  export type Database = {
    exec(query: string): QueryResult[];
    iterateStatements(query: string): IterableIterator<Statement>;
    close(): void;
  };
  export default function initSqlJs(config: { locateFile: () => string }): Promise<{ Database: new (data: Uint8Array) => Database }>;
}
