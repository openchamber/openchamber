export class SpaceError<Details = null, Code = string> extends Error {
  code: Code;
  details: Details | null;

  constructor(code: Code, message: string, details: Details | null = null) {
    super(message);
    this.name = 'SpaceError';
    this.code = code;
    this.details = details;
  }
}

const hasErrorProperties = (value: unknown): value is { code?: unknown; message?: unknown; details?: unknown; cause?: unknown; execFailed?: unknown } => value != null;
export const spaceErrorProperty = <Value>(value: Value, key: 'code' | 'message' | 'details' | 'cause' | 'execFailed') => hasErrorProperties(value) ? value[key] : undefined;
