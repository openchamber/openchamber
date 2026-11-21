import 'node:fs';
import 'node:stream';

declare module 'node:fs' {
  function createWriteStream(path: null, options: { fd: number }): WriteStream;
}

declare module 'node:stream' {
  interface Writable {
    write(
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean;
  }
}
