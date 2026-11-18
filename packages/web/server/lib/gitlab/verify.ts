import { fetchWithTimeout, GitLabRequestError } from './network.js';
import { parseGitLabUser } from './user.js';

export interface GitLabTokenVerificationOptions {
  origin: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface VerificationFailure {
  message?: unknown;
}

const isVerificationFailure = (value: unknown): value is VerificationFailure => value != null;

export async function verifyGitLabToken({ origin, token, fetch: fetchImpl = fetch, timeoutMs = 10_000 }: GitLabTokenVerificationOptions) {
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${origin}/api/v4/user`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, timeoutMs);
  } catch (error) {
    const message = isVerificationFailure(error) ? error.message : undefined;
    throw new GitLabRequestError('unreachable', message || 'GitLab instance is unreachable');
  }
  if (response.status === 401) throw new GitLabRequestError('invalid-token', 'GitLab token is invalid', response.status);
  if (response.status === 403) throw new GitLabRequestError('unavailable', 'GitLab token verification is forbidden', response.status);
  if (response.status === 429 || response.status >= 500) throw new GitLabRequestError('temporarily-unavailable', 'GitLab is temporarily unavailable', response.status);
  if (!response.ok) throw new GitLabRequestError('provider-error', 'Failed to verify GitLab token', response.status);
  return parseGitLabUser(await response.json());
}
