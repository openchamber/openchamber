export type GitHubApiErrorCode = 'search_timeout' | 'not_found' | 'repo_unavailable';

/**
 * Parse a GitHub list failure code from a server response. Every other value
 * means the response carries no GitHub failure code.
 */
export function parseGitHubApiErrorCode(value: unknown): GitHubApiErrorCode | null {
  switch (value) {
    case 'search_timeout':
    case 'not_found':
    case 'repo_unavailable':
      return value;
    default:
      return null;
  }
}

/**
 * Read the failure code from an error thrown by a GitHub API call, or null
 * when the error carries no known code.
 */
export function getGitHubApiErrorCode(error: unknown): GitHubApiErrorCode | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  return parseGitHubApiErrorCode(error.code);
}
