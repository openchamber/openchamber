import type { Serializable } from 'node:child_process';

declare global {
  interface ObjectConstructor {
    hasOwn(value: Serializable, property: PropertyKey): boolean;
  }
}
