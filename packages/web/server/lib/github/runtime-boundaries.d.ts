import type { AuthJson } from '../source-control/auth-storage.js';

declare global {
  interface ErrorConstructor {
    new(message?: unknown, options?: ErrorOptions): Error;
  }
}

declare module 'node:crypto' {
  interface Hash {
    update(data: Exclude<AuthJson, string>): never;
  }
}
