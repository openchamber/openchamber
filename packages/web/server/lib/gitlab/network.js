import { isString } from './validation.js';

export class GitLabRequestError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export function classifyGitLabFailure(error) {
  if (error instanceof GitLabRequestError) return error.kind;
  const code = isString(error?.code) ? error.code : '';
  if (error?.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code.startsWith('ERR_TLS')) return 'unreachable';
  return 'provider-error';
}

export async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
