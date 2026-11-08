import { z } from 'zod';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

/**
 * Links a pull request, merge request or issue to a session: the agent's way
 * of doing what the composer, the New Worktree dialog and the chat's Linked
 * section do for the user.
 *
 * The agent hands over the whole record (url, title, kind, optional
 * identifier) in one service-neutral shape, so nothing is looked up and any
 * tracker works. Only the URL is trusted for what the thing is: a github.com
 * pull request or issue becomes the native GitHub entry (with live state), a
 * registered tracker's item link (its `matchUrl`) becomes a tracker entry
 * (`trackerEntryKind`), and any other address is stored as an `external` entry, whose id is the
 * thread's canonical address when a source-control provider's `urls.thread`
 * names one. The shapes are the UI's (`packages/ui/src/lib/linkedIssues.ts`),
 * under `openchamber.linked_issues`.
 *
 * Linking only: removing a link stays with the user, so an agent never drops
 * one the user set.
 */

const MAX_TITLE_LENGTH = 300;
const MAX_IDENTIFIER_LENGTH = 64;

// The native entry the UI keeps for a repository thread exists for github.com
// only (`linkedIssues.ts`): owner/repo#number, pull or issue. A discussion is
// an external entry with the canonical id the UI writes for one too.
const NATIVE_THREAD = { provider: 'github', host: 'github.com' };

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
 * The source-control provider whose `urls.thread` names this address as a
 * change request or issue, with the pattern's match, else null. The match
 * ends where the thread does, so tabs such as `/diffs` and a query fall
 * outside it.
 */
const threadPathOf = (host, pathname) => {
  for (const descriptor of sourceControlProviderDescriptors.list()) {
    const { hosts, pattern } = descriptor.urls.thread;
    if (hosts !== 'any' && !hosts.includes(host)) continue;
    const match = pattern.exec(pathname);
    if (match) return { provider: descriptor.id, match };
  }
  return null;
};

/**
 * The stored kind of a tracker's linked entry. Older bundled UIs (phone apps
 * that talk to a newer server) know only `kind: 'linear'`: they drop any
 * other kind from the list they show and write back, so a Linear link stored
 * as `tracker` would vanish on their next link. While the `/api/linear` alias
 * still serves those UIs, Linear keeps `kind: 'linear'` with `provider` beside
 * it (older validators ignore the extra field); other trackers, which older
 * UIs cannot show anyway, are `tracker`. Readers accept both.
 */
const trackerEntryKind = (provider) => (provider === 'linear' ? 'linear' : 'tracker');

/**
 * The stored entry for an agent's link. The URL decides the service, and for
 * a native GitHub thread also whether it is a pull request: an address says
 * that more reliably than the kind a model filled in. `matchTrackerUrl(url)`
 * answers `{ provider, identifier }` for a registered tracker's item link.
 */
export const buildLinkEntry = (input, linkedAt, { matchTrackerUrl = () => null } = {}) => {
  const parsed = linkInputSchema.safeParse(input);
  if (!parsed.success) return { error: 'link needs url, title, and kind (change or issue); identifier is optional' };
  const { title, kind, identifier } = parsed.data;
  const url = parseHttpUrl(parsed.data.url);
  if (!url) return { error: 'link.url must be an absolute http(s) URL' };
  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  const thread = threadPathOf(host, url.pathname);
  // A discussion has no native entry: it is stored as an external link, which
  // every UI keeps, and a newer UI reads it as a discussion by its address.
  if (thread?.provider === NATIVE_THREAD.provider && host === NATIVE_THREAD.host && thread.match[3] !== 'discussions') {
    const [, owner, repo, threadKind, rawNumber] = thread.match;
    const number = Number(rawNumber);
    return { entry: {
      id: `${owner}/${repo}#${number}`,
      number,
      title,
      url: url.toString(),
      kind: threadKind === 'pull' ? 'pull' : 'issue',
      linkedAt,
    } };
  }

  const tracked = matchTrackerUrl(url.toString());
  if (tracked) {
    const itemIdentifier = tracked.identifier.toUpperCase();
    return { entry: {
      id: `${tracked.provider}:${itemIdentifier}`,
      kind: trackerEntryKind(tracked.provider),
      provider: tracked.provider,
      identifier: itemIdentifier,
      title,
      url: url.toString(),
      linkedAt,
    } };
  }

  url.hash = '';
  // One thread is one entry however its address was written: the same merge
  // request linked again from its Changes tab, or with a query, refreshes the
  // first link.
  const canonical = thread ? `${url.origin}${thread.match[0].replace(/\/$/, '')}` : null;
  // A GitHub discussion is named by its number, as the UI names one it links.
  const discussion = thread?.provider === NATIVE_THREAD.provider && thread.match[3] === 'discussions' ? `#${Number(thread.match[4])}` : null;
  return { entry: {
    id: `link:${canonical ?? url.toString()}`,
    kind: 'external',
    // The address says a discussion is no code change, whatever the model filled in.
    thread: discussion ? 'issue' : kind,
    identifier: identifier || discussion || host,
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

/**
 * A matcher over every registered tracker's `matchUrl`, in registry order. A
 * tracker that fails to load is left out: its links are stored as external
 * ones rather than refused.
 */
const trackerUrlMatcher = async (trackers) => {
  const matchers = [];
  for (const provider of trackers?.list() ?? []) {
    try {
      const tracker = await trackers.implementation(provider);
      if (tracker?.matchUrl instanceof Function) matchers.push({ provider, matchUrl: tracker.matchUrl });
    } catch { /* as above */ }
  }
  return (url) => {
    for (const { provider, matchUrl } of matchers) {
      const identifier = matchUrl(url);
      if (identifier) return { provider, identifier };
    }
    return null;
  };
};

/** `trackers` is the tracker registry; its trackers' links become tracker entries. */
export const createSessionLinker = ({ updateMetadata, createError, trackers = null, now = Date.now }) => {
  const link = async ({ sessionId, directory, link: input }) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const { entry, error } = buildLinkEntry(input, now(), { matchTrackerUrl: await trackerUrlMatcher(trackers) });
    if (error) throw createError(error, 400);

    const { changed } = await updateMetadata(sessionId, (current) => buildLinkPatch(current, entry), { directory: directory ?? '' });
    return { sessionId, linked: entry, changed };
  };

  return { link };
};
