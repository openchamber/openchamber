import type { Session } from '@/lib/opencode/model';
import { isJsonValue, type JsonValue } from '@openchamber/sdk';
import { getSessionMetadata, type SessionMetadataRecord } from './sessionReviewMetadata';

/**
 * Issues and pull requests a user has linked to a session.
 *
 * Stored as a **snapshot**, not a reference: identifier or number, title, author
 * and avatar only. Enough to render a row and open the thing, and nothing more.
 *
 * Rides the same session-metadata channel as pinned messages
 * (`contextObligatoryMessages`), so it inherits their persistence and sync for
 * free.
 */

export type LinkedGitHubIssue = {
  /** `owner/repo#number`, unique per session and stable across renames. */
  id: string;
  number: number;
  title: string;
  url: string;
  kind: 'issue' | 'pull';
  author?: string;
  authorAvatarUrl?: string;
  linkedAt: number;
};

export type LinkedLinearIssue = {
  /** `linear:{identifier}`, unique per session. */
  id: string;
  identifier: string;
  title: string;
  url: string;
  kind: 'linear';
  author?: string;
  authorAvatarUrl?: string;
  linkedAt: number;
};

export type LinkedGuestIssue = {
  /** `guest:{providerId}:{identifier}`, unique per session. */
  id: string;
  providerId: string;
  identifier: string;
  title: string;
  url: string;
  kind: 'guest';
  /** Missing on older snapshots; those are issues. */
  thread?: 'issue' | 'pull';
  author?: string;
  head?: string;
  base?: string;
  /** Opaque guest payload from `attach`, handed back as `ready.item.data`. Never shown or sent to the model. */
  data?: JsonValue;
  linkedAt: number;
};

const isGuestPull = (entry: { thread?: 'issue' | 'pull' }): boolean => (
  entry.thread === 'pull'
);

/**
 * A thread on any other service, linked by an agent through `session.link`
 * (`packages/web/server/lib/github/session-link.js`): a GitLab merge request,
 * a Jira ticket. Shown by identifier and opened by URL; no live state.
 */
export type LinkedExternalItem = {
  /** `link:{url}`, unique per session. */
  id: string;
  kind: 'external';
  /** `change` is any code change under review: a pull, merge or change request. */
  thread: 'issue' | 'change';
  /** The service's short label, such as `!42` or `OPS-7`; the URL's host when none was given. */
  identifier: string;
  title: string;
  url: string;
  linkedAt: number;
};

export type LinkedIssue = LinkedGitHubIssue | LinkedLinearIssue | LinkedGuestIssue | LinkedExternalItem;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isLinkedGitHubIssue = (value: unknown): value is LinkedGitHubIssue => (
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

const isLinkedLinearIssue = (value: unknown): value is LinkedLinearIssue => (
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && typeof value.identifier === 'string'
  && value.identifier.length > 0
  && typeof value.title === 'string'
  && typeof value.url === 'string'
  && value.kind === 'linear'
  && typeof value.linkedAt === 'number'
  && Number.isFinite(value.linkedAt)
);

const isLinkedGuestIssue = (value: unknown): value is LinkedGuestIssue => (
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && typeof value.providerId === 'string'
  && value.providerId.length > 0
  && typeof value.identifier === 'string'
  && value.identifier.length > 0
  && typeof value.title === 'string'
  && typeof value.url === 'string'
  && value.kind === 'guest'
  && (value.thread === undefined || value.thread === 'issue' || value.thread === 'pull')
  && (value.author === undefined || typeof value.author === 'string')
  && (value.head === undefined || typeof value.head === 'string')
  && (value.base === undefined || typeof value.base === 'string')
  && (value.data === undefined || isJsonValue(value.data as JsonValue))
  && typeof value.linkedAt === 'number'
  && Number.isFinite(value.linkedAt)
);

const isLinkedExternalItem = (value: unknown): value is LinkedExternalItem => (
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && value.kind === 'external'
  && (value.thread === 'issue' || value.thread === 'change')
  && typeof value.identifier === 'string'
  && value.identifier.length > 0
  && typeof value.title === 'string'
  && typeof value.url === 'string'
  && typeof value.linkedAt === 'number'
  && Number.isFinite(value.linkedAt)
);

const isLinkedIssue = (value: unknown): value is LinkedIssue => (
  isLinkedGitHubIssue(value) || isLinkedLinearIssue(value) || isLinkedGuestIssue(value) || isLinkedExternalItem(value)
);

/** A linked thread that is a code change under review rather than an issue. */
export const isLinkedChange = (entry: LinkedIssue): boolean => (
  entry.kind === 'pull'
  || (entry.kind === 'guest' && isGuestPull(entry))
  || (entry.kind === 'external' && entry.thread === 'change')
);

export const buildLinkedIssueId = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}#${number}`;

const buildLinkedLinearIssueId = (identifier: string): string =>
  `linear:${identifier}`;

/**
 * Builds the stored snapshot from what an attach flow already has.
 *
 * The id comes from the URL rather than a separate owner/repo pair: every flow
 * that attaches a thread has its URL, and only some of them carry the repo
 * separately. A URL that does not parse falls back to itself, which is still
 * unique per thread — the id only has to identify an entry, not be pretty.
 */
export const buildLinkedIssue = (input: {
  url: string;
  number: number;
  title: string;
  kind: 'issue' | 'pull';
  author?: { login?: string; avatarUrl?: string } | null;
  linkedAt: number;
}): LinkedGitHubIssue => {
  const match = /github\.com\/([^/]+)\/([^/]+)\//.exec(input.url);
  const id = match
    ? buildLinkedIssueId(match[1], match[2], input.number)
    : `${input.url}#${input.number}`;

  return {
    id,
    number: input.number,
    title: input.title,
    url: input.url,
    kind: input.kind,
    author: input.author?.login ?? undefined,
    authorAvatarUrl: input.author?.avatarUrl ?? undefined,
    linkedAt: input.linkedAt,
  };
};

export const buildLinkedGuestIssue = (input: {
  providerId: string;
  identifier: string;
  title: string;
  url: string;
  thread?: 'issue' | 'pull';
  author?: string;
  head?: string;
  base?: string;
  data?: JsonValue;
  linkedAt: number;
}): LinkedGuestIssue => {
  const next: LinkedGuestIssue = {
    id: `guest:${input.providerId}:${input.identifier}`,
    providerId: input.providerId,
    identifier: input.identifier,
    title: input.title,
    url: input.url,
    kind: 'guest',
    thread: input.thread === 'pull' ? 'pull' : 'issue',
    linkedAt: input.linkedAt,
  };
  if (input.author?.trim()) {
    next.author = input.author.trim();
  }
  if (next.thread === 'pull') {
    if (input.head?.trim()) {
      next.head = input.head.trim();
    }
    if (input.base?.trim()) {
      next.base = input.base.trim();
    }
  }
  if (input.data !== undefined) {
    next.data = input.data;
  }
  return next;
};

export const buildLinkedLinearIssue = (input: {
  identifier: string;
  title: string;
  url: string;
  author?: { login?: string; avatarUrl?: string } | null;
  linkedAt: number;
}): LinkedLinearIssue => ({
  id: buildLinkedLinearIssueId(input.identifier),
  identifier: input.identifier,
  title: input.title,
  url: input.url,
  kind: 'linear',
  author: input.author?.login ?? undefined,
  authorAvatarUrl: input.author?.avatarUrl ?? undefined,
  linkedAt: input.linkedAt,
});

export const canOpenLinearIssueInContextPanel = (options: {
  linearAvailable: boolean;
  linearConnected: boolean;
  inDedicatedMobileShell: boolean;
  directory: string | null | undefined;
}): boolean => (
  options.linearAvailable
  && options.linearConnected
  && !options.inDedicatedMobileShell
  && Boolean(options.directory?.trim())
);

export const getLinkedIssues = (session: Session | null | undefined): LinkedIssue[] => {
  const openchamber = getSessionMetadata(session).openchamber;
  if (!isRecord(openchamber) || !Array.isArray(openchamber.linked_issues)) return [];
  // Malformed entries are dropped rather than rendered: a half-written link
  // has no row worth showing.
  return openchamber.linked_issues.filter(isLinkedIssue);
};

export type LinkedGitHubPullRequest = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
};

const LINKED_ISSUE_ID_PATTERN = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/;
const GITHUB_THREAD_URL_PATTERN = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d+)(?:[/?#]|$)/i;

/** A linked thread that lives on github.com, wherever the link came from. */
export type GitHubThreadRef = { key: string; owner: string; repo: string; number: number; thread: 'pull' | 'issue' };

/**
 * The GitHub thread behind a link, or null. A GitHub entry carries it in its
 * id; an extension's or agent's link to a github.com address is the same
 * thread, so it gets the same live state and is not listed twice. Entries
 * whose id is a URL that names no repository cannot be looked up.
 */
export const getGitHubThreadRef = (entry: LinkedIssue): GitHubThreadRef | null => {
  if (entry.kind === 'issue' || entry.kind === 'pull') {
    const match = LINKED_ISSUE_ID_PATTERN.exec(entry.id);
    if (!match || Number(match[3]) !== entry.number) return null;
    return { key: entry.id, owner: match[1], repo: match[2], number: entry.number, thread: entry.kind };
  }
  if (entry.kind === 'linear') return null;
  const match = GITHUB_THREAD_URL_PATTERN.exec(entry.url);
  if (!match) return null;
  const number = Number(match[4]);
  return { key: buildLinkedIssueId(match[1], match[2], number), owner: match[1], repo: match[2], number, thread: match[3].toLowerCase() === 'pull' ? 'pull' : 'issue' };
};

// Each GitHub thread once, however many times and by whom it was linked.
const uniqueGitHubThreads = (session: Session | null | undefined, thread: GitHubThreadRef['thread']) => {
  const seen = new Set<string>();
  return getLinkedIssues(session).flatMap((entry) => {
    const ref = getGitHubThreadRef(entry);
    if (!ref || ref.thread !== thread || seen.has(ref.key.toLowerCase())) return [];
    seen.add(ref.key.toLowerCase());
    return [{ ref, entry }];
  });
};

/**
 * The session's links as a list shows them: each GitHub thread once, at its
 * first link, however many times and by whom it was linked.
 */
export const getDistinctLinkedIssues = (session: Session | null | undefined): LinkedIssue[] => {
  const seen = new Set<string>();
  return getLinkedIssues(session).filter((entry) => {
    const key = getGitHubThreadRef(entry)?.key.toLowerCase();
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** GitHub pull requests linked to a session, with their repository. */
export const getLinkedGitHubPullRequests = (session: Session | null | undefined): LinkedGitHubPullRequest[] => (
  uniqueGitHubThreads(session, 'pull').map(({ ref, entry }) => (
    { owner: ref.owner, repo: ref.repo, number: ref.number, url: entry.url, title: entry.title }
  ))
);

/** A code change linked to a session from a service without live state here. */
export type LinkedSidebarChange = { key: string; identifier: string; url: string; title: string };

/**
 * Pull and merge requests linked from services other than GitHub (an
 * extension's PR, an agent's GitLab merge request), in link order. The sidebar
 * lists them beside GitHub PRs, by identifier and without a state colour.
 */
export const getLinkedSidebarChanges = (session: Session | null | undefined): LinkedSidebarChange[] => (
  getLinkedIssues(session).flatMap((entry) => (
    (entry.kind === 'guest' || entry.kind === 'external') && isLinkedChange(entry) && !getGitHubThreadRef(entry)
      ? [{ key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }]
      : []
  ))
);

/** An issue linked to a session, as the sidebar shows it. */
export type LinkedSidebarIssue =
  | { source: 'github'; key: string; owner: string; repo: string; number: number; url: string; title: string }
  | { source: 'linear' | 'guest' | 'external'; key: string; identifier: string; url: string; title: string };

/**
 * Issues linked to a session, in link order. GitHub issues carry their
 * repository (read from the entry id) so their state can be looked up;
 * Linear and extension trackers are shown by identifier only. Pull requests,
 * including extension ones, are not issues here.
 */
export const getLinkedSidebarIssues = (session: Session | null | undefined): LinkedSidebarIssue[] => {
  const githubIssues = new Map(uniqueGitHubThreads(session, 'issue').map(({ ref, entry }) => [entry.id, ref]));
  return getLinkedIssues(session).flatMap((entry): LinkedSidebarIssue[] => {
    const ref = getGitHubThreadRef(entry);
    if (ref) {
      // A GitHub issue, or a duplicate of one listed earlier; never a PR.
      const unique = githubIssues.get(entry.id);
      return unique ? [{ source: 'github', key: unique.key, owner: unique.owner, repo: unique.repo, number: unique.number, url: entry.url, title: entry.title }] : [];
    }
    if (entry.kind === 'issue' || entry.kind === 'pull') return [];
    if (entry.kind === 'linear') {
      return [{ source: 'linear', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'guest' && !isGuestPull(entry)) {
      return [{ source: 'guest', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'external' && entry.thread === 'issue') {
      return [{ source: 'external', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
    }
    return [];
  });
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
