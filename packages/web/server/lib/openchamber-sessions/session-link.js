import { z } from 'zod';

/**
 * Links a pull request, merge request or issue to a session: the agent's way
 * of doing what the composer, the New Worktree dialog and the chat's Linked
 * section do for the user.
 *
 * The agent hands over the whole record (url, title, kind, optional
 * identifier) in one service-neutral shape, so nothing is looked up and any
 * tracker works. Only the URL is trusted for what the thing is: a GitHub or
 * Linear address becomes the entry those services already have, with live
 * state for GitHub; any other address is stored as an `external` entry. The
 * shapes are the UI's (`packages/ui/src/lib/linkedIssues.ts`), under
 * `openchamber.linked_issues`.
 *
 * Linking only: removing a link stays with the user, so an agent never drops
 * one the user set.
 */

const MAX_TITLE_LENGTH = 300;
const MAX_IDENTIFIER_LENGTH = 64;

const GITHUB_PATTERN = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)(?:\/|$)/;
const LINEAR_PATTERN = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$)/;

const linkInputSchema = z.object({
  url: z.string().trim().min(1),
  title: z.string().trim().min(1).transform((title) => title.slice(0, MAX_TITLE_LENGTH)),
  kind: z.enum(['change', 'issue']),
  identifier: z.string().trim().max(MAX_IDENTIFIER_LENGTH).optional(),
});

const parseHttpUrl = (value) => {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
};

/**
 * The stored entry for an agent's link. The URL decides the service, and for
 * GitHub also whether it is a pull request: an address says that more
 * reliably than the kind a model filled in.
 */
export const buildLinkEntry = (input, linkedAt) => {
  const parsed = linkInputSchema.safeParse(input);
  if (!parsed.success) return { error: 'link needs url, title, and kind (change or issue); identifier is optional' };
  const { title, kind, identifier } = parsed.data;
  const url = parseHttpUrl(parsed.data.url);
  if (!url) return { error: 'link.url must be an absolute http(s) URL' };
  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'github.com') {
    const match = GITHUB_PATTERN.exec(url.pathname);
    if (match) {
      const number = Number(match[4]);
      return { entry: {
        id: `${match[1]}/${match[2]}#${number}`,
        number,
        title,
        url: url.toString(),
        kind: match[3] === 'pull' ? 'pull' : 'issue',
        linkedAt,
      } };
    }
  }

  if (host === 'linear.app') {
    const match = LINEAR_PATTERN.exec(url.pathname);
    if (match) {
      const issueIdentifier = match[1].toUpperCase();
      return { entry: { id: `linear:${issueIdentifier}`, identifier: issueIdentifier, title, url: url.toString(), kind: 'linear', linkedAt } };
    }
  }

  url.hash = '';
  return { entry: {
    id: `link:${url.toString()}`,
    kind: 'external',
    thread: kind,
    identifier: identifier || host,
    title,
    url: url.toString(),
    linkedAt,
  } };
};

const linkedEntrySchema = z.looseObject({ id: z.string() });
const linkMetadataSchema = z.looseObject({
  openchamber: z.looseObject({ linked_issues: z.array(z.unknown()).catch([]) }).catch({ linked_issues: [] }),
}).catch({ openchamber: { linked_issues: [] } });

const SNAPSHOT_KEYS = ['number', 'identifier', 'title', 'url', 'kind', 'thread'];

/**
 * The metadata patch that puts `entry` into the link list, or null when the
 * same link is already there unchanged. Re-linking refreshes the snapshot
 * (a renamed pull request) and keeps the original link time and position;
 * fields the agent cannot know, such as the author a picker recorded, stay.
 */
export const buildLinkPatch = (metadata, entry) => {
  const current = linkMetadataSchema.parse(metadata ?? {}).openchamber.linked_issues;
  const index = current.findIndex((item) => linkedEntrySchema.safeParse(item).data?.id === entry.id);
  if (index === -1) return { openchamber: { linked_issues: [...current, entry] } };

  const existing = linkedEntrySchema.parse(current[index]);
  const refreshed = { ...existing, ...entry, linkedAt: existing.linkedAt ?? entry.linkedAt };
  if (SNAPSHOT_KEYS.every((key) => existing[key] === refreshed[key])) return null;
  const next = [...current];
  next[index] = refreshed;
  return { openchamber: { linked_issues: next } };
};

export const createSessionLinker = ({ updateMetadata, createError, now = Date.now }) => {
  const link = async ({ sessionId, directory, link: input }) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const { entry, error } = buildLinkEntry(input, now());
    if (error) throw createError(error, 400);

    const { changed } = await updateMetadata(sessionId, (current) => buildLinkPatch(current, entry), { directory: directory ?? '' });
    return { sessionId, linked: entry, changed };
  };

  return { link };
};
