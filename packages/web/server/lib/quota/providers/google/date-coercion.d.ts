import type { JsonValue } from '../../utils/contracts.js';

declare global {
  interface DateConstructor {
    new (value: JsonValue): Date;
  }
}
