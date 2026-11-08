import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { isJsonValue, type JsonValue } from '@openchamber/sdk';
import { getSessionMetadata, type SessionMetadataRecord } from './sessionReviewMetadata';
import type { RepositoryUrlMatcher } from './source-control/repositoryUrlMatcher';
import { formatChangeRequestReference } from './source-control/providers/terminology';
import { joinProjectPath } from './source-control/projectPath';
import { storedTrackerLinkKind } from './trackers/legacyLinear';

/**
 * Source-control issues and change requests, and tracker work items, a user has
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

/**
 * A tracker's work item (a Linear issue). Entries stored before trackers had
 * their own kind read `kind: 'linear'` without a provider; they are read as
 * Linear's.
 */
type LinkedTrackerItem = {
  /** `{provider}:{identifier}`, unique per session. */
  id: string;
  kind: 'tracker';
  provider: string;
  identifier: string;
  title: string;
  url: string;
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
 * (`packages/web/server/lib/openchamber-sessions/session-link.js`): a GitLab merge request,
 * a Jira ticket. Shown by identifier and opened by URL; one on a source-control
 * provider gets live state from its instance (`getRepositoryThreadRef`), others
 * have none.
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

export type LinkedIssue = LinkedRepositoryIssue | LinkedTrackerItem | LinkedGuestIssue | LinkedExternalItem;

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

const trackerEntryFields = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  url: z.string(),
  author: z.string().optional().catch(undefined),
  authorAvatarUrl: z.string().optional().catch(undefined),
  linkedAt: z.number(),
});

/** A tracker entry; a Linear one stored before trackers had their own kind reads as Linear's. */
const linkedTrackerItemSchema = z.union([
  trackerEntryFields.extend({ kind: z.literal('tracker'), provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }),
  trackerEntryFields.extend({ kind: z.literal('linear') })
    .transform((entry) => ({ ...entry, kind: 'tracker' as const, provider: 'linear' })),
]) satisfies z.ZodType<LinkedTrackerItem>;

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

const isLinkedIssue = (value: unknown): value is Exclude<LinkedIssue, LinkedTrackerItem> => (
  isLinkedRepositoryIssue(value) || isLinkedGuestIssue(value) || isLinkedExternalItem(value)
);

/** Every stored entry that holds together, in the current shape; malformed ones are dropped. */
const linkedIssueListSchema = z.array(z.unknown()).catch([]).transform((values) => values.flatMap((value): LinkedIssue[] => {
  if (isLinkedIssue(value)) return [value];
  const tracker = linkedTrackerItemSchema.safeParse(value);
  return tracker.success ? [tracker.data] : [];
}));

/** A linked thread that is a code change under review rather than an issue. */
export const isLinkedChange = (entry: LinkedIssue): boolean => (
  entry.kind === 'pull'
  || (entry.kind === 'guest' && isGuestPull(entry))
  || (entry.kind === 'external' && entry.thread === 'change')
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

/**
 * The stored snapshot of a discussion. A discussion has no entry of its own:
 * it is an external link, which every client keeps when it rewrites the list
 * (one that knows no discussion entry would drop it), named by its canonical
 * address the way an agent's link to it is (`session-link.js`), so the two
 * are one entry. A newer client reads it as a discussion by that address
 * (`getRepositoryThreadRef`).
 */
export const buildLinkedDiscussion = (input: { url: string; number: number; title: string; linkedAt: number }): LinkedExternalItem => {
  let canonical = input.url;
  try {
    const parsed = new URL(input.url);
    const thread = /^\/[^/]+\/[^/]+\/discussions\/\d+/.exec(parsed.pathname);
    if (thread) canonical = `${parsed.origin}${thread[0]}`;
  } catch {
    // The URL itself stays a stable id for malformed provider data.
  }
  return {
    id: `link:${canonical}`,
    kind: 'external',
    thread: 'issue',
    identifier: `#${input.number}`,
    title: input.title,
    url: input.url,
    linkedAt: input.linkedAt,
  };
};

/** The stored snapshot of a tracker's work item; the id keeps the identifier's case (`linear:ENG-12`). */
export const buildLinkedTrackerItem = (input: {
  provider: string;
  identifier: string;
  title: string;
  url: string;
  author?: { login?: string; avatarUrl?: string } | null;
  linkedAt: number;
}): LinkedTrackerItem => ({
  id: `${input.provider}:${input.identifier}`,
  kind: 'tracker',
  provider: input.provider,
  identifier: input.identifier,
  title: input.title,
  url: input.url,
  author: input.author?.login ?? undefined,
  authorAvatarUrl: input.author?.avatarUrl ?? undefined,
  linkedAt: input.linkedAt,
});

/** An entry as it is stored in session metadata and sent to the server. */
type StoredLinkedIssue = Exclude<LinkedIssue, LinkedTrackerItem> | (Omit<LinkedTrackerItem, 'kind'> & { kind: 'tracker' | 'linear' });

/**
 * The stored form of an entry: a Linear item keeps `kind: 'linear'` (with
 * `provider` beside it), which older clients read and keep when they rewrite
 * the list (`storedTrackerLinkKind`). Readers accept both kinds.
 */
export const toStoredLinkedIssue = (entry: LinkedIssue): StoredLinkedIssue => (
  entry.kind === 'tracker' ? { ...entry, kind: storedTrackerLinkKind(entry.provider) } : entry
);

export const getLinkedIssues = (session: Session | null | undefined): LinkedIssue[] => {
  const openchamber = getSessionMetadata(session).openchamber;
  if (!isRecord(openchamber) || !Array.isArray(openchamber.linked_issues)) return [];
  // Malformed entries are dropped rather than rendered: a half-written link
  // has no row worth showing.
  return linkedIssueListSchema.parse(openchamber.linked_issues);
};

/**
 * A linked issue, discussion or change request on a source-control provider, read from
 * its address against the providers' URL patterns. `owner` is the namespace
 * path where the provider nests them (GitLab subgroups). `key` names the thread
 * across every way it can be linked (a repository attach, an agent's link, an
 * extension's), so it is listed and followed once.
 */
export type RepositoryThreadRef = {
  key: string;
  provider: string;
  instance: string;
  owner: string;
  repo: string;
  number: number;
  thread: 'pull' | 'issue' | 'discussion';
};

/**
 * The repository thread behind a link, or null. Every kind of link but a
 * tracker one can name one: an attached issue or change request, and an
 * extension's or agent's link to the same address, which then gets the same
 * live state and is not listed twice. An attached entry keeps its own kind and
 * number; a link whose address disagrees with them is not looked up.
 */
export const getRepositoryThreadRef = (entry: LinkedIssue, matcher: RepositoryUrlMatcher): RepositoryThreadRef | null => {
  if (entry.kind === 'tracker') return null;
  const match = matcher.match(entry.url);
  if (!match || !Number.isSafeInteger(match.number) || match.number < 1) return null;
  const repositoryEntry = entry.kind === 'issue' || entry.kind === 'pull';
  if (repositoryEntry && match.number !== entry.number) return null;
  const thread = repositoryEntry ? entry.kind : match.kind;
  return {
    key: `${match.provider}|${match.instance}|${joinProjectPath(match.owner, match.repo)}|${thread}#${match.number}`.toLowerCase(),
    provider: match.provider,
    instance: match.instance,
    owner: match.owner,
    repo: match.repo,
    number: match.number,
    thread,
  };
};

/** How the provider writes a linked thread's number: `#12`, `!12`. */
const repositoryThreadIdentifier = (ref: RepositoryThreadRef, matcher: RepositoryUrlMatcher): string => {
  const descriptor = matcher.descriptorOf(ref.provider);
  return ref.thread === 'pull'
    ? formatChangeRequestReference(descriptor, ref.number)
    : `${descriptor.terminology.issuePrefix}${ref.number}`;
};

/**
 * The session's links as a list shows them: each repository thread once, at
 * its first link, however many times and by whom it was linked.
 */
export const getDistinctLinkedIssues = (session: Session | null | undefined, matcher: RepositoryUrlMatcher): LinkedIssue[] => {
  const seen = new Set<string>();
  return getLinkedIssues(session).filter((entry) => {
    const key = getRepositoryThreadRef(entry, matcher)?.key;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** A code change linked to a session, as the sidebar shows it. */
export type LinkedSidebarChange = {
  key: string;
  /** `#12`, `!12`, or an extension's own identifier. */
  identifier: string;
  url: string;
  title: string;
  /** Set for a change request on a source-control provider, whose live state is looked up by it. */
  repository?: RepositoryThreadRef;
};

/**
 * Every code change linked to a session, in link order: pull and merge
 * requests on any source-control provider (attached in the composer or linked
 * by an agent or extension), each once and carrying its thread for live state,
 * and changes from elsewhere, shown by identifier.
 */
export const getLinkedSidebarChanges = (session: Session | null | undefined, matcher: RepositoryUrlMatcher): LinkedSidebarChange[] => {
  const seen = new Set<string>();
  return getLinkedIssues(session).flatMap((entry): LinkedSidebarChange[] => {
    if (!isLinkedChange(entry)) return [];
    const repository = getRepositoryThreadRef(entry, matcher);
    // A discussion an agent called a change is an issue all the same: its address says so.
    if (repository?.thread === 'discussion') return [];
    if (repository) {
      if (seen.has(repository.key)) return [];
      seen.add(repository.key);
      return [{ key: repository.key, identifier: repositoryThreadIdentifier(repository, matcher), url: entry.url, title: entry.title, repository }];
    }
    // An attached change request whose address no provider reads.
    if (entry.kind === 'pull') return [{ key: entry.id, identifier: `#${entry.number}`, url: entry.url, title: entry.title }];
    return entry.kind === 'guest' || entry.kind === 'external'
      ? [{ key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }]
      : [];
  });
};

/** An issue linked to a session, as the sidebar shows it; a discussion is one of its repository issues. */
export type LinkedSidebarIssue =
  | { source: 'repository'; key: string; ref: RepositoryThreadRef & { thread: 'issue' | 'discussion' }; identifier: string; url: string; title: string }
  | { source: 'tracker'; provider: string; key: string; identifier: string; url: string; title: string }
  | { source: 'guest' | 'external'; key: string; identifier: string; url: string; title: string };

/**
 * Issues linked to a session, in link order, discussions among them.
 * Repository issues carry their
 * thread, so their state can be looked up, each once; tracker items carry
 * their tracker, whose live state is looked up by identifier; extension
 * items are shown by identifier. Change requests, including extension
 * ones, are not issues here.
 */
export const getLinkedSidebarIssues = (session: Session | null | undefined, matcher: RepositoryUrlMatcher): LinkedSidebarIssue[] => {
  const seen = new Set<string>();
  return getLinkedIssues(session).flatMap((entry): LinkedSidebarIssue[] => {
    const ref = getRepositoryThreadRef(entry, matcher);
    if (isLinkedChange(entry) && ref?.thread !== 'discussion') return [];
    if (ref) {
      // A repository issue or discussion, or a duplicate of one listed earlier. An agent's or
      // extension's issue link whose address names a change request is neither.
      const { thread } = ref;
      if (thread === 'pull' || seen.has(ref.key)) return [];
      seen.add(ref.key);
      return [{ source: 'repository', key: ref.key, ref: { ...ref, thread }, identifier: repositoryThreadIdentifier(ref, matcher), url: entry.url, title: entry.title }];
    }
    // An attached issue whose address no provider reads: no live state.
    if (entry.kind === 'issue') {
      return [{ source: 'external', key: entry.id, identifier: `#${entry.number}`, url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'tracker') {
      return [{ source: 'tracker', provider: entry.provider, key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'guest') {
      return [{ source: 'guest', key: entry.id, identifier: entry.identifier, url: entry.url, title: entry.title }];
    }
    if (entry.kind === 'external') {
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
    ? linkedIssueListSchema.parse(openchamber.linked_issues)
    : [];
  const withoutIssue = current.filter((entry) => !isSameLinkedEntry(entry, issue));
  // Re-linking an existing entry replaces it, so a stale title can be refreshed
  // by linking again.
  const next = linked ? [...withoutIssue, issue] : withoutIssue;

  return {
    ...metadata,
    openchamber: {
      ...openchamber,
      linked_issues: next.map(toStoredLinkedIssue),
    },
  };
};
