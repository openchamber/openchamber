import type { Session } from '@opencode-ai/sdk/v2';
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

export type LinkedIssue = LinkedGitHubIssue | LinkedLinearIssue;

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

const isLinkedIssue = (value: unknown): value is LinkedIssue => (
  isLinkedGitHubIssue(value) || isLinkedLinearIssue(value)
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
