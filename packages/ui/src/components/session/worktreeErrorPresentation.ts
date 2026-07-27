export const PULL_REQUEST_SOURCE_UNAVAILABLE_CODE = 'pull_request_unavailable';
export const PULL_REQUEST_SOURCE_UNAVAILABLE_TRANSLATION_KEY = 'session.newWorktree.error.pullRequestUnavailable';

export const getWorktreeErrorPresentationKey = (
  error: unknown,
): typeof PULL_REQUEST_SOURCE_UNAVAILABLE_TRANSLATION_KEY | null => {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      ? (error as { message?: unknown }).message
      : undefined;
  const statusError = typeof error === 'object' && error !== null && 'error' in error
    ? (error as { error?: unknown }).error
    : undefined;

  if (
    code === PULL_REQUEST_SOURCE_UNAVAILABLE_CODE
    || message === PULL_REQUEST_SOURCE_UNAVAILABLE_CODE
    || statusError === PULL_REQUEST_SOURCE_UNAVAILABLE_CODE
  ) {
    return PULL_REQUEST_SOURCE_UNAVAILABLE_TRANSLATION_KEY;
  }

  return null;
};
