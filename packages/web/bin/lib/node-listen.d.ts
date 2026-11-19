import 'node:net';
import type { JsonValue } from '../../server/lib/shared/json-values.js';

declare module 'node:net' {
  interface Server {
    listen(options: { port: number; host: JsonValue | undefined }, callback: () => void): this;
  }
}
