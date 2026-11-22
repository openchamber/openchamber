// Query integers judged as written. A fork module.
import { isString } from '../shared/guards.js';
import type { QueryValue } from '../shared/http-contracts.js';

// A binding revision is an exact count, so its query spelling is judged as
// written: no trim, sign, fraction, exponent, radix prefix or leading zeros.
// A loose Number(...) would reinterpret "1e3" as 1000 and pass the binding
// authority check whenever that happened to be the current revision.
export function requestNonNegativeInteger(value: QueryValue | undefined) {
  if (!isString(value) || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
