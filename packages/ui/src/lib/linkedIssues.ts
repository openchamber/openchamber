import type { Session } from '@/lib/opencode/model';
import { isJsonValue, type JsonValue } from '@openchamber/sdk';
import { getSessionMetadata, type SessionMetadataRecord } from './sessionReviewMetadata';

/**
 * Source-control issues and change requests, and tracker issues, a user has
 * linked to a session.
 *
 * Stored as a **snapshot**, not a reference: identifier or number, title, author
 * and avatar only. Enough to render a row and open the thing, and nothing more.
 * The body, comments and state of an issue belong to its provider, and mirroring
 * them here would mean owning their staleness. The stored title can drift from
 * the real one; that is the accepted cost of a storage that never needs
 * refreshing.
 *
 * Rides the same session-metadata channel as pinned messages
 * (`contextObligatoryMessages`), so it inherits their persistence and sync for
 * free.
 */

type LinkedRepositoryIssue = {
  /**
   * `owner/repo#number` on github.com, `host:owner/repo#number` on any other
   * instance, unique per session and stable across renames. Entries stored
   * before the host was added carry the bare shape whatever their instance.
   */
  id: string;
  number: number;
  title: string;
  url: string;
  kind: 'issue' | 'pull';
  author?: string;
  authorAvatarUrl?: string;
  linkedAt: number;
};

type LinkedLinearIssue = {
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
 * a Jira ticket. Shown by identifier and opened by URL; a GitLab one gets live
 * state from its instance (`getGitLabThreadRef`), others have none.
 */
type LinkedExternalItem = {
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

export type LinkedIssue = LinkedRepositoryIssue | LinkedLinearIssue | LinkedGuestIssue | LinkedExternalItem;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isLinkedRepositoryIssue = (value: unknown): value is LinkedRepositoryIssue => (
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
  isLinkedRepositoryIssue(value) || isLinkedLinearIssue(value) || isLinkedGuestIssue(value) || isLinkedExternalItem(value)
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
}): LinkedRepositoryIssue => {
  let project: { host: string; owner: string; name: string } | null = null;
  try {
    const parsed = new URL(input.url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const threadIndex = segments.findIndex((segment) => (
      segment === 'issues' || segment === 'pull'
    ));
    const projectNameIndex = segments[threadIndex - 1] === '-' ? threadIndex - 2 : threadIndex - 1;
    const owner = segments.slice(0, projectNameIndex).join('/');
    const name = segments[projectNameIndex];
    if (threadIndex > 1 && owner && name) project = { host: parsed.hostname.toLowerCase(), owner, name };
  } catch {
    // The URL itself remains a stable fallback id for malformed provider data.
  }
  // github.com keeps the bare shape every stored GitHub link already has; any
  // other instance names its host, so team/repo#12 there is not the GitHub one.
  const id = !project
    ? `${input.url}#${input.number}`
    : project.host === 'github.com' || project.host === 'www.github.com'
      ? buildLinkedIssueId(project.owner, project.name, input.number)
      : `${project.host}:${buildLinkedIssueId(project.owner, project.name, input.number)}`;

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
type GitHubThreadRef = { key: string; owner: string; repo: string; number: number; thread: 'pull' | 'issue' };

/**
 * The GitHub thread behind a link, or null. A GitHub entry carries it in its
 * id; an extension's or agent's link to a github.com address is the same
 * thread, so it gets the same live state and is not listed twice. Entries
 * whose id is a URL that names no repository cannot be looked up.
 */
export const getGitHubThreadRef = (entry: LinkedIssue): GitHubThreadRef | null => {
  if (entry.kind === 'issue' || entry.kind === 'pull') {
    // GitLab issues and merge requests share these kinds and the same id
    // shape; only a github.com address is a GitHub thread.
    if (!GITHUB_THREAD_URL_PATTERN.test(entry.url)) return null;
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

/** A linked thread on a GitLab instance: `owner` is the namespace path, subgroups included. */
export type GitLabThreadRef = { key: string; instance: string; owner: string; repo: string; number: number; thread: 'pull' | 'issue' };

// GitLab puts its own routes behind `/-/`, so the project path is everything
// before it, however deep the subgroups go.
const GITLAB_THREAD_URL_PATTERN = /^(https?:\/\/[^/\s]+)\/(.+)\/([^/\s]+)\/-\/(merge_requests|issues|work_items)\/(\d+)(?:[/?#]|$)/i;

/**
 * The GitLab thread behind a link, or null: a merge request or issue attached
 * from a GitLab project, or an agent's link to one. Read from the address, the
 * one field every such link carries.
 */
export const getGitLabThreadRef = (entry: LinkedIssue): GitLabThreadRef | null => {
  if (entry.kind === 'linear' || entry.kind === 'guest' || getGitHubThreadRef(entry)) return null;
  const match = GITLAB_THREAD_URL_PATTERN.exec(entry.url.trim());
  if (!match) return null;
  const number = Number(match[5]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const instance = match[1].toLowerCase();
  const thread = match[4].toLowerCase() === 'merge_requests' ? 'pull' : 'issue';
  return { key: `${instance}/${match[2]}/${match[3]}${thread === 'pull' ? '!' : '#'}${number}`.toLowerCase(), instance, owner: match[2], repo: match[3], number, thread };
};

/** Each GitLab merge request and issue linked to a session, once. */
export const getLinkedGitLabThreads = (session: Session | null | undefined): GitLabThreadRef[] => {
  const seen = new Set<string>();
  return getLinkedIssues(session).flatMap((entry) => {
    const ref = getGitLabThreadRef(entry);
    if (!ref || seen.has(ref.key)) return [];
    seen.add(ref.key);
    return [ref];
  });
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

/** A code change linked to a session from a service other than GitHub. */
export type LinkedSidebarChange = {
  key: string;
  identifier: string;
  url: string;
  title: string;
  /** Set for a GitLab merge request, whose live state is looked up by it. */
  gitlab?: GitLabThreadRef;
};

/**
 * Pull and merge requests linked from services other than GitHub (an
 * extension's PR, a GitLab merge request attached in the composer or linked by
 * an agent), in link order, each GitLab merge request once. The sidebar lists
 * them beside GitHub PRs; GitLab ones carry their thread for live state, the
 * rest show by identifier, uncoloured.
 */
export const getLinkedSidebarChanges = (session: Session | null | undefined): LinkedSidebarChange[] => {
  const seen = new Set<string>();
  return getLinkedIssues(session).flatMap((entry): LinkedSidebarChange[] => {
    if (!isLinkedChange(entry) || getGitHubThreadRef(entry)) return [];
    const gitlab = getGitLabThreadRef(entry);
    if (gitlab) {
      if (seen.has(gitlab.key)) return [];
      seen.add(gitlab.key);
      return [{ key: entry.id, identifier: `!${gitlab.number}`, url: entry.url, title: entry.title, gitlab }];
    }
    // A merge request attached from a GitLab repository.
    if (entry.kind === 'pull') return [{ key: entry.id, identifier: `!${entry.number}`, url: entry.url, title: entry.title }];
    return entry.kind === 'guest' || entry.kind === 'external'
      ? [{ key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }]
      : [];
  });
};

/** An issue linked to a session, as the sidebar shows it. */
export type LinkedSidebarIssue =
  | { source: 'github'; key: string; owner: string; repo: string; number: number; url: string; title: string }
  | { source: 'gitlab'; key: string; ref: GitLabThreadRef; identifier: string; url: string; title: string }
  | { source: 'linear' | 'guest' | 'external'; key: string; identifier: string; url: string; title: string };

/**
 * Issues linked to a session, in link order. GitHub issues carry their
 * repository (read from the entry id) and GitLab issues their thread, so their
 * state can be looked up; Linear and extension trackers are shown by identifier. Pull requests,
 * including extension ones, are not issues here.
 */
export const getLinkedSidebarIssues = (session: Session | null | undefined): LinkedSidebarIssue[] => {
  const githubIssues = new Map(uniqueGitHubThreads(session, 'issue').map(({ ref, entry }) => [entry.id, ref]));
  const seenGitLab = new Set<string>();
  return getLinkedIssues(session).flatMap((entry): LinkedSidebarIssue[] => {
    const gitlab = isLinkedChange(entry) ? null : getGitLabThreadRef(entry);
    if (gitlab) {
      if (seenGitLab.has(gitlab.key)) return [];
      seenGitLab.add(gitlab.key);
      return [{ source: 'gitlab', key: entry.id, ref: gitlab, identifier: `#${gitlab.number}`, url: entry.url, title: entry.title }];
    }
    const ref = getGitHubThreadRef(entry);
    if (ref) {
      // A GitHub issue, or a duplicate of one listed earlier; never a PR.
      const unique = githubIssues.get(entry.id);
      return unique ? [{ source: 'github', key: unique.key, owner: unique.owner, repo: unique.repo, number: unique.number, url: entry.url, title: entry.title }] : [];
    }
    if (entry.kind === 'pull') return [];
    // An issue attached from a GitLab repository: no live state here yet.
    if (entry.kind === 'issue') {
      return [{ source: 'external', key: entry.id, identifier: `#${entry.number}`, url: entry.url, title: entry.title }];
    }
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

const normalizedThreadUrl = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Whether two entries name the same thread. A repository entry stored before
 * ids carried the host matches its new id by its address instead.
 */
const isSameLinkedEntry = (entry: LinkedIssue, issue: LinkedIssue): boolean => {
  if (entry.id === issue.id) return true;
  return (entry.kind === 'issue' || entry.kind === 'pull')
    && entry.kind === issue.kind
    && entry.number === issue.number
    && normalizedThreadUrl(entry.url) === normalizedThreadUrl(issue.url);
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
  const withoutIssue = current.filter((entry) => !isSameLinkedEntry(entry, issue));
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
