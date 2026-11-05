declare module 'sql.js/dist/sql-wasm.js' {
  export type QueryResult = { columns: string[]; values: Array<Array<string | number | bigint | Uint8Array | null>> };
  export type Database = { exec(query: string, params?: undefined, config?: { useBigInt: boolean }): QueryResult[]; close(): void };
  export default function initSqlJs(config: { locateFile: () => string }): Promise<{ Database: new (data: Uint8Array) => Database }>;
}
