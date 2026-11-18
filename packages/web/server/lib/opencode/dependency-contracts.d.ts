import 'stream/web';

declare global {
  function parseInt<Value>(value: Value, radix?: number): number;
}

export interface BunSqliteModule {
  Database: new (filePath: string) => {
    query(sql: string): {
      all(...params: (string | number)[]): unknown[];
      run(...params: (string | number)[]): void;
    };
    close(): void;
  };
}

declare module 'stream/web' {
  interface ReadableStream<R> {
    getReader(options: { mode: 'byob' }): globalThis.ReadableStreamBYOBReader;
    getReader(): globalThis.ReadableStreamDefaultReader<R>;
    getReader(options?: { mode?: 'byob' }): globalThis.ReadableStreamReader<R>;
  }
}
