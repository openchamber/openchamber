const GITHUB_HOSTNAMES = new Set(['github.com', 'www.github.com']);
const SCHEME_LESS_GITHUB_URL = /^(?:www\.)?github\.com\//i;
const GITHUB_ITEM_PATH = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/;
const BARE_REFERENCE = /^#?(\d+)$/;

/**
 * Parse a user-supplied query as an exact GitHub reference: a bare number,
 * `#number`, or an issue/PR URL on github.com. Returns the number plus the
 * URL's owner/repo when present, or null when the value is free text
 * (including mixed text+number queries like `123 bug`).
 *
 * @param {string} value
 * @returns {{ kind: 'issue' | 'pr' | null; number: number; owner?: string; repo?: string } | null}
 */
export function parseGitHubReference(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const bareMatch = trimmed.match(BARE_REFERENCE);
  if (bareMatch) {
    const number = Number(bareMatch[1]);
    return number > 0 ? { kind: null, number } : null;
  }

  const candidate = SCHEME_LESS_GITHUB_URL.test(trimmed) ? `https://${trimmed}` : trimmed;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTNAMES.has(url.hostname.toLowerCase())) return null;

  const pathMatch = url.pathname.match(GITHUB_ITEM_PATH);
  if (!pathMatch) return null;

  const number = Number(pathMatch[4]);
  if (!Number.isFinite(number) || number <= 0) return null;

  return {
    kind: pathMatch[3] === 'issues' ? 'issue' : 'pr',
    number,
    owner: pathMatch[1],
    repo: pathMatch[2],
  };
}
