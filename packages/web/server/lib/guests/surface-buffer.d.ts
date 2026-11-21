import type { RawData } from '../shared/websocket-contracts.js';

declare global {
  interface BufferConstructor {
    from(data: RawData): Buffer;
  }
}
