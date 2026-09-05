export const STALE_GIT_HISTORY_CURSOR_CODE = 'stale_git_history_cursor';

export class GitHistoryRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, options: { status: number; code?: string }) {
    super(message);
    this.name = 'GitHistoryRequestError';
    this.status = options.status;
    this.code = options.code;
  }
}

export const isStaleGitHistoryCursorError = (error: Error): boolean => {
  if (error instanceof GitHistoryRequestError && error.code === STALE_GIT_HISTORY_CURSOR_CODE) {
    return true;
  }

  const message = error.message.toLowerCase();
  return message.includes('stale') && message.includes('cursor');
};
