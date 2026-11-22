import { fetchWithDeadline } from '../shared/bounded-fetch.js';
import { isString } from './validation.js';

export type GitLabFailureKind = 'unreachable' | 'invalid-token' | 'unavailable' | 'temporarily-unavailable' | 'provider-error';

export class GitLabRequestError extends Error {
  declare kind: GitLabFailureKind;
  declare status: number | null;

  constructor(kind: GitLabFailureKind, cause: unknown, status: number | null = null) {
    super(cause === undefined ? undefined : `${cause}`);
    this.kind = kind;
    this.status = status;
  }
}

// Auth answers are fixed-shape and tiny: a version string, a device
// authorization, OAuth token answers, and the user profile whose consumed
// fields are id/username/avatar_url/name/email (user.js) add up to KiB at
// most in practice. Their JSON reads are therefore capped at 1 MiB — over
// 100x headroom over a legitimate answer, yet 1/16 of the API client's
// 16 MiB SUCCESS_BODY_MAX_BYTES (client.js), which has to fit paginated
// lists and raw files. The cap is enforced while the body streams in
// through ../shared/response-body.js, never by buffering the whole answer
// first: the instance answering is user-configured and possibly
// self-managed, and the 10s deadline bounds stalls, not bytes.
export const AUTH_BODY_MAX_BYTES = 1 * 1024 * 1024;
interface FailureFields {
  code?: unknown;
  name?: unknown;
}

const hasFailureFields = (value: unknown): value is FailureFields => value != null;

export function classifyGitLabFailure(cause: unknown): GitLabFailureKind {
  if (cause instanceof GitLabRequestError) return cause.kind;
  const error = hasFailureFields(cause) ? cause : undefined;
  const code = isString(error?.code) ? error.code : '';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code.startsWith('ERR_TLS')) return 'unreachable';
  return 'provider-error';
}

export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit = {}, timeoutMs = 10_000) {
  // Delegates to the shared deadline (design #802 phase 2, #804), keeping
  // this name and signature for its importers. Two behaviour changes are
  // the design's intended contract: the caller's signal (init.signal)
  // composes with the deadline instead of being overwritten by it, and the
  // deadline stays armed until the response body has been read instead of
  // clearing when the headers arrive.
  return fetchWithDeadline(fetchImpl, url, { ...init, redirect: 'error' }, { timeoutMs, ...(init?.signal ? { signal: init.signal } : {}) });
}
