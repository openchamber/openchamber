import { fetchWithTimeout, GitLabRequestError } from './network.js';
import { parseGitLabUser } from './user.js';

export async function verifyGitLabToken({ origin, token, fetch: fetchImpl = fetch, timeoutMs = 10_000 }) {
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${origin}/api/v4/user`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, timeoutMs);
  } catch (error) {
    throw new GitLabRequestError('unreachable', error?.message || 'GitLab instance is unreachable');
  }
  if (response.status === 401) throw new GitLabRequestError('invalid-token', 'GitLab token is invalid', response.status);
  if (response.status === 403) throw new GitLabRequestError('unavailable', 'GitLab token verification is forbidden', response.status);
  if (response.status === 429 || response.status >= 500) throw new GitLabRequestError('temporarily-unavailable', 'GitLab is temporarily unavailable', response.status);
  if (!response.ok) throw new GitLabRequestError('provider-error', 'Failed to verify GitLab token', response.status);
  return parseGitLabUser(await response.json());
}
