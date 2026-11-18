import 'stream/web';

declare module 'stream/web' {
  interface ReadableStream<R> {
    getReader(options: { mode: 'byob' }): globalThis.ReadableStreamBYOBReader;
    getReader(): globalThis.ReadableStreamDefaultReader<R>;
    getReader(options?: { mode?: 'byob' }): globalThis.ReadableStreamReader<R>;
  }
}
