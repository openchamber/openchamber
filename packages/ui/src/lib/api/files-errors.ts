import { z } from 'zod';

export type FilesystemErrorReason =
  | 'os-permission'
  | 'already-exists'
  | 'not-found'
  | 'not-directory'
  | 'invalid-response'
  | 'unknown';

export class FilesystemError extends Error {
  readonly reason: FilesystemErrorReason;
  readonly status?: number;

  constructor(message: string, options: { reason?: FilesystemErrorReason; status?: number } = {}) {
    super(message);
    this.name = 'FilesystemError';
    this.reason = options.reason ?? 'unknown';
    this.status = options.status;
  }
}

export const isFilesystemError = (error: unknown): error is FilesystemError => (
  error instanceof FilesystemError
  || Boolean(
    error
    && typeof error === 'object'
    && 'reason' in error
    && typeof (error as { reason?: unknown }).reason === 'string'
  )
);

export const parseFilesystemErrorReason = (value: unknown): FilesystemErrorReason => {
  switch (value) {
    case 'os-permission':
    case 'already-exists':
    case 'not-found':
    case 'not-directory':
    case 'invalid-response':
      return value;
    default:
      return 'unknown';
  }
};

// Web rejects with an Error; the VS Code bridge rejects with a plain object
// that carries the message.
const messageCarrierSchema = z.object({ message: z.string() });

export const isFileMissingError = (error: unknown): boolean => {
  if (isFilesystemError(error) && error.reason === 'not-found') {
    return true;
  }
  const carrier = messageCarrierSchema.safeParse(error);
  const message = error instanceof Error ? error.message : carrier.success ? carrier.data.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('file not found')
    || normalized.includes('enoent')
    || normalized.includes('no such file')
    || normalized.includes('does not exist');
};

