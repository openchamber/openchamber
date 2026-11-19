import type * as NodeStreams from 'node:stream/web';

declare global {
  interface ReadableStream<R> {
    getReader(options: { mode: 'byob' }): NodeStreams.ReadableStreamBYOBReader;
    getReader(): NodeStreams.ReadableStreamDefaultReader<R>;
    getReader(options?: NodeStreams.ReadableStreamGetReaderOptions): NodeStreams.ReadableStreamReader<R>;
    pipeThrough<T>(transform: NodeStreams.ReadableWritablePair<T, R>, options?: NodeStreams.StreamPipeOptions): NodeStreams.ReadableStream<T>;
  }
}
