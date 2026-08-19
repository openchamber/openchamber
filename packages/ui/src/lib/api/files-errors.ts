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
