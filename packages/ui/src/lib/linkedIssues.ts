import type { Session } from '@opencode-ai/sdk/v2';
import type { ForgeProviderKind } from '@/lib/forge/types';
import { parseGitHost } from '@/lib/gitHost';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { normalizeProviderDomain, useGitProviderDomainsStore } from '@/stores/useGitProviderDomainsStore';
import { getSessionMetadata, type SessionMetadataRecord } from './sessionReviewMetadata';

/**
 * Git-forge issues and pull requests a user has linked to a session.
 *
 * Stored as a **snapshot**, not a reference: number, title, author and avatar,
 * plus the entity's identity (provider, repo, host) — enough to render a row,
 * open the thing, and look the entity up for live status. The body, comments
 * and state of an issue belong to the forge, and mirroring them here would
 * mean owning their staleness. The stored title can drift from the real one;
 * that is the accepted cost of a storage that never needs refreshing.
 *
 * `provider`, `repo` and `host` are derived from the link url (and, for
 * self-hosted instances, the connected auth accounts and configured domains)
 * the moment the link is recorded. They are still a snapshot of the entity's
 * identity — never live data.
 *
 * Rides the same session-metadata channel as pinned messages
 * (`contextObligatoryMessages`), so it inherits their persistence and sync for
 * free.
 */

export type LinkedIssue = {
  /** `owner/repo#number`, unique per session and stable across renames. */
  id: string;
  number: number;
  title: string;
  url: string;
  kind: 'issue' | 'pull';
  author?: string;
  authorAvatarUrl?: string;
  /** 'github' | 'gitlab' | 'gitea' — derived from the URL when not supplied. */
  provider?: ForgeProviderKind;
  /** Project path from the URL: 'owner/repo' (github/gitea) or 'namespace/project' (gitlab). */
  repo?: string;
  /** Bare hostname the entity lives on (e.g. 'github.com', 'git.example.com'). */
  host?: string;
  linkedAt: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isLinkedIssue = (value: unknown): value is LinkedIssue => (
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && typeof value.number === 'number'
  && Number.isFinite(value.number)
  && typeof value.title === 'string'
  && typeof value.url === 'string'
  && (value.kind === 'issue' || value.kind === 'pull')
  && typeof value.linkedAt === 'number'
  && Number.isFinite(value.linkedAt)
);

export const buildLinkedIssueId = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}#${number}`;

/**
 * Builds the stored snapshot from what an attach flow already has.
 *
 * The id comes from the URL rather than a separate owner/repo pair: every flow
 * that attaches a thread has its URL, and only some of them carry the repo
 * separately. A URL that does not parse falls back to itself, which is still
 * unique per thread — the id only has to identify an entry, not be pretty.
 */
const GITHUB_URL_RE = /github\.com\/([^/]+)\/([^/]+)\//;
// GitLab puts the project path (possibly nested namespaces, e.g. a/b/project)
// before the `/-/issues|/merge_requests/` segment on any host. The legacy
// non-`/-/` issue/merge-request URLs are accepted too.
const GITLAB_URL_RE = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?(?:issues|merge_requests)\/\d+/;
// Gitea and Forgejo use a flat `owner/repo` path with no `/-/` segment:
// `https://host/owner/repo/pulls/N` or `/issues/N`. GitHub is tried first and
// GitLab second (whose legacy `issues|merge_requests` branch also catches
// gitea `/issues/` urls), so by the time this runs, a remaining
// `/owner/repo/(pulls|issues)/N` url is a gitea-style one.
const GITEA_URL_RE = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/\d+/;

const buildStableIssueId = (url: string, number: number): string => {
  const githubMatch = GITHUB_URL_RE.exec(url);
  if (githubMatch) {
    return buildLinkedIssueId(githubMatch[1], githubMatch[2], number);
  }

  const gitlabMatch = GITLAB_URL_RE.exec(url);
  if (gitlabMatch) {
    return `${gitlabMatch[1]}#${number}`;
  }

  const giteaMatch = GITEA_URL_RE.exec(url);
  if (giteaMatch) {
    return buildLinkedIssueId(giteaMatch[1], giteaMatch[2], number);
  }

  return `${url}#${number}`;
};

/**
 * Bare hostname of a link url. `parseGitHost` handles the git-remote forms;
 * a direct URL parse covers any residue it rejects.
 */
const getIssueUrlHost = (url: string): string | null => {
  const fromGitHost = parseGitHost(url);
  if (fromGitHost) return fromGitHost;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
};

/**
 * Which forge a link url belongs to. Well-known hosts resolve without any
 * state; self-hosted hosts resolve through the connected auth accounts' base
 * urls and the user-configured domains, in precedence order github -> gitlab ->
 * gitea. Returns null when nothing is known — never a guess, so github-branded
 * UI is not offered for an unknown host. github.com is matched first so it can
 * never be mistaken for a gitea host.
 */
export const deriveLinkedIssueProvider = (url: string): ForgeProviderKind | null => {
  const host = getIssueUrlHost(url);
  if (!host) return null;

  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  if (host === 'gitea.com') return 'gitea';

  const giteaAccountHosts = (useGiteaAuthStore.getState().status?.accounts ?? [])
    .map((account) => normalizeProviderDomain(account.baseUrl))
    .filter((candidate): candidate is string => candidate !== null);
  if (giteaAccountHosts.includes(host)) return 'gitea';

  const gitlabAccountHosts = (useGitLabAuthStore.getState().status?.accounts ?? [])
    .map((account) => normalizeProviderDomain(account.baseUrl))
    .filter((candidate): candidate is string => candidate !== null);
  if (gitlabAccountHosts.includes(host)) return 'gitlab';

  // GitHub accounts carry no base URL (they are github.com-only, which the
  // built-in match above already handles), so there is no host to consult.

  const { domains } = useGitProviderDomainsStore.getState();
  if (domains.github.includes(host)) return 'github';
  if (domains.gitlab.includes(host)) return 'gitlab';
  if (domains.gitea.includes(host)) return 'gitea';

  return null;
};

/**
 * The project path portion of a link url's stable id: `owner/repo` for
 * github/gitea, the full `namespace/project` for gitlab. Returns null when the
 * url does not parse into a forge id.
 */
export const deriveLinkedIssueRepo = (url: string, number: number): string | null => {
  const id = buildStableIssueId(url, number);
  const hashIndex = id.lastIndexOf('#');
  if (hashIndex <= 0) return null;
  const path = id.slice(0, hashIndex);
  // A url that failed to parse yields the url itself as the id path; that is
  // not a repo, so report nothing rather than a nonsense value.
  if (path === url || path.length === 0) return null;
  return path;
};

// A pasted forge issue/PR URL, split into its identity pieces. The path must
// end in `issues|pull|pulls|merge_requests/<number>` with an owner/repo (or,
// for gitlab, nested namespace) path before the entity segment; the optional
// `-/` covers GitLab's modern `/-/issues` route. Strict on purpose: the Link
// dialog's paste box has no other signal to guess from, so a non-matching URL
// is invalid rather than best-effort.
const FORGE_ENTITY_URL_RE = /^(?:https?:\/\/)?[^/\s]+\/(.+?)\/(?:-\/)?(issues|pull|pulls|merge_requests)\/(\d+)\/?$/;

/**
 * Parse a forge issue/PR URL pasted into the Link control into the pieces the
 * facade needs. `provider` resolves through `deriveLinkedIssueProvider`
 * (well-known hosts, connected auth accounts, configured domains) so an
 * unknown host returns null instead of a guess; `repo` is the project path
 * (`owner/repo`, or the full gitlab namespace path); `kind` comes from the
 * URL's entity segment; `number` from its trailing digits.
 */
export const parseForgeEntityUrl = (url: string): {
  provider: ForgeProviderKind;
  repo: string;
  number: number;
  kind: 'issue' | 'pull';
} | null => {
  const trimmed = url.trim();
  const provider = deriveLinkedIssueProvider(trimmed);
  if (!provider) return null;

  // Query strings, fragments and trailing slashes are URL noise, not part of
  // the entity identity.
  const cleaned = trimmed.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  const match = FORGE_ENTITY_URL_RE.exec(cleaned);
  if (!match) return null;

  const path = match[1].split('/').filter((segment) => segment.length > 0);
  if (path.length < 2) return null;

  const number = Number(match[3]);
  if (!Number.isFinite(number) || number < 1) return null;

  return {
    provider,
    repo: path.join('/'),
    number,
    kind: match[2] === 'issues' ? 'issue' : 'pull',
  };
};

/**
 * A linked issue broken into the pieces the forge APIs need to look it up:
 * provider, top-level namespace (owner), gitlab multi-segment namespace, repo
 * and number. Built from the stored id (`path#number`); the provider comes
 * from the entry when recorded, else is derived from the url, else inferred
 * from the id shape (multi-segment paths are gitlab-style nested namespaces).
 */
export type LinkedIssueRef = {
  provider: ForgeProviderKind;
  /** Top-level namespace (github/gitea owner; gitlab top-level namespace). */
  owner: string;
  /** GitLab multi-segment namespace path (e.g. 'a/b'); absent for github/gitea. */
  namespace?: string;
  repo: string;
  number: number;
};

export const parseLinkedIssueRef = (entry: LinkedIssue): LinkedIssueRef | null => {
  const hashIndex = entry.id.lastIndexOf('#');
  if (hashIndex <= 0) return null;

  const path = entry.id.slice(0, hashIndex);
  const rawNumber = entry.id.slice(hashIndex + 1);
  if (rawNumber.length === 0) return null;
  const number = Number(rawNumber);
  if (!Number.isFinite(number)) return null;

  // Fallback ids embed the whole url (`${url}#${number}`) and cannot be
  // resolved to a forge entity.
  if (path === entry.url || path.includes('://')) return null;

  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;

  const explicitProvider = entry.provider;
  const provider = explicitProvider === 'github' || explicitProvider === 'gitlab' || explicitProvider === 'gitea'
    ? explicitProvider
    : deriveLinkedIssueProvider(entry.url);

  if (provider === 'gitlab') {
    const repo = segments[segments.length - 1];
    const namespace = segments.slice(0, -1).join('/');
    return { provider, owner: segments[0], namespace, repo, number };
  }

  if (provider === 'github' || provider === 'gitea') {
    return { provider, owner: segments[0], repo: segments[1], number };
  }

  // No provider derivable: infer from the id shape. Multi-segment paths are
  // gitlab-style (nested namespaces), flat paths github-style.
  if (segments.length >= 3) {
    const repo = segments[segments.length - 1];
    const namespace = segments.slice(0, -1).join('/');
    return { provider: 'gitlab', owner: segments[0], namespace, repo, number };
  }
  return { provider: 'github', owner: segments[0], repo: segments[1], number };
};

export const buildLinkedIssue = (input: {
  url: string;
  number: number;
  title: string;
  kind: 'issue' | 'pull';
  author?: { login?: string; avatarUrl?: string } | null;
  linkedAt: number;
  /** Explicit overrides; when absent, provider/repo/host are derived from the url. */
  provider?: ForgeProviderKind;
  repo?: string;
  host?: string;
}): LinkedIssue => {
  const id = buildStableIssueId(input.url, input.number);

  return {
    id,
    number: input.number,
    title: input.title,
    url: input.url,
    kind: input.kind,
    author: input.author?.login ?? undefined,
    authorAvatarUrl: input.author?.avatarUrl ?? undefined,
    linkedAt: input.linkedAt,
    provider: input.provider ?? deriveLinkedIssueProvider(input.url) ?? undefined,
    repo: input.repo ?? deriveLinkedIssueRepo(input.url, input.number) ?? undefined,
    host: input.host ?? parseGitHost(input.url) ?? undefined,
  };
};

export const getLinkedIssues = (session: Session | null | undefined): LinkedIssue[] => {
  const openchamber = getSessionMetadata(session).openchamber;
  if (!isRecord(openchamber) || !Array.isArray(openchamber.linked_issues)) return [];
  // Malformed entries are dropped rather than rendered: a half-written link
  // has no row worth showing.
  return openchamber.linked_issues.filter(isLinkedIssue);
};

export const withLinkedIssue = (
  metadata: SessionMetadataRecord,
  issue: LinkedIssue,
  linked: boolean,
): SessionMetadataRecord => {
  const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
  const current = Array.isArray(openchamber.linked_issues)
    ? openchamber.linked_issues.filter(isLinkedIssue)
    : [];
  const withoutIssue = current.filter((entry) => entry.id !== issue.id);
  // Re-linking an existing entry replaces it, so a stale title can be refreshed
  // by linking again.
  const next = linked ? [...withoutIssue, issue] : withoutIssue;

  return {
    ...metadata,
    openchamber: {
      ...openchamber,
      linked_issues: next,
    },
  };
};
