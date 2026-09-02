import { PULL_REQUEST_SOURCE_UNAVAILABLE_CODE } from './types.js';

/**
 * Thrown when the PR head ref cannot be reached through either the fork
 * remote (when provided) or the base remote's `refs/pull/<n>/head`.
 *
 * Carries a stable `code` so callers can map this to a structured
 * transport error code (web routes serialise `code`; the VS Code bridge
 * forwards it to the webview).
 */
export class PullRequestSourceUnavailableError extends Error {
  public readonly code: typeof PULL_REQUEST_SOURCE_UNAVAILABLE_CODE;

  constructor() {
    super(PULL_REQUEST_SOURCE_UNAVAILABLE_CODE);
    this.name = 'PullRequestSourceUnavailableError';
    this.code = PULL_REQUEST_SOURCE_UNAVAILABLE_CODE;
  }
}

export const createPullRequestSourceUnavailableError = (): PullRequestSourceUnavailableError =>
  new PullRequestSourceUnavailableError();
