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

interface FailureFields {
  code?: unknown;
  name?: unknown;
}

const hasFailureFields = (value: unknown): value is FailureFields => value != null;

export function classifyGitLabFailure(cause: unknown): GitLabFailureKind {
  if (cause instanceof GitLabRequestError) return cause.kind;
  const error = hasFailureFields(cause) ? cause : undefined;
  const code = isString(error?.code) ? error.code : '';
  if (error?.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code.startsWith('ERR_TLS')) return 'unreachable';
  return 'provider-error';
}

export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
