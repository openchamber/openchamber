interface FailureFields {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  execFailed?: unknown;
  status?: unknown;
}

const isPropertyRecord = (value: unknown): value is FailureFields => value !== null && (typeof value === 'object' || typeof value === 'function');

export function failureProperty(cause: unknown, key: keyof FailureFields) {
  const boxed: unknown = Object(cause);
  return isPropertyRecord(boxed) ? boxed[key] : undefined;
}

export function requiredFailureProperty(cause: unknown, key: keyof FailureFields) {
  if (cause === null || cause === undefined) throw new TypeError(`Cannot read properties of ${cause} (reading '${key}')`);
  return failureProperty(cause, key);
}
