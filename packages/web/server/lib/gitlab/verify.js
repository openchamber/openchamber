import { readBoundedResponseText } from '../shared/response-body.js';
import { AUTH_BODY_MAX_BYTES, fetchWithTimeout, GitLabRequestError } from './network.js';
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
  const read = await readBoundedResponseText(response, AUTH_BODY_MAX_BYTES);
  if (read.tooLarge) throw new GitLabRequestError('provider-error', `GitLab auth response exceeded ${AUTH_BODY_MAX_BYTES} bytes`, response.status);
  // Response.json() strips a leading UTF-8 BOM; the bounded reader does
  // not, so strip it here like client.js parseBody does. A malformed body
  // keeps the old shape: JSON.parse throws, as response.json() did.
  return parseGitLabUser(JSON.parse(read.text.replace(/^\uFEFF/, '')));
}
