import { z } from 'zod';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { buildLinkedIssuesPatch } from './session-linked-issues.js';


const MAX_TITLE_LENGTH = 300;
const MAX_IDENTIFIER_LENGTH = 64;

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

const threadPathOf = (host, pathname) => {
  for (const descriptor of sourceControlProviderDescriptors.list()) {
    const { hosts, pattern } = descriptor.urls.thread;
    if (hosts !== 'any' && !hosts.includes(host)) continue;
    const match = pattern.exec(pathname);
    if (match) return { provider: descriptor.id, match };
  }
  return null;
};

const trackerEntryKind = (provider) => (provider === 'linear' ? 'linear' : 'tracker');

export const buildLinkEntry = (input, linkedAt, { matchTrackerUrl = () => null } = {}) => {
  const parsed = linkInputSchema.safeParse(input);
  if (!parsed.success) return { error: 'Pass the link as parameters.link: { url, title, kind: "change" | "issue", identifier? }; the link was not added' };
  const { title, kind, identifier } = parsed.data;
  const url = parseHttpUrl(parsed.data.url);
  if (!url) return { error: 'link.url must be an absolute http(s) URL' };
  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  const thread = threadPathOf(host, url.pathname);
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
  const canonical = thread ? `${url.origin}${thread.match[0].replace(/\/$/, '')}` : null;
  const discussion = thread?.provider === NATIVE_THREAD.provider && thread.match[3] === 'discussions' ? `#${Number(thread.match[4])}` : null;
  return { entry: {
    id: `link:${canonical ?? url.toString()}`,
    kind: 'external',
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

const storedLinkSchema = z.looseObject({
  id: z.string(),
  url: z.string().optional().catch(undefined),
  identifier: z.string().optional().catch(undefined),
  number: z.number().optional().catch(undefined),
  kind: z.string().optional().catch(undefined),
  title: z.string().optional().catch(undefined),
});

const comparableUrl = (value) => {
  const url = parseHttpUrl(value.trim());
  if (!url) return null;
  url.hash = '';
  return url.toString().replace(/\/+$/, '').toLowerCase();
};

const storedLinks = (metadata) => linkMetadataSchema.parse(metadata ?? {}).openchamber.linked_issues
  .flatMap((item) => {
    const parsed = storedLinkSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });

const findLinkedEntries = (metadata, { url, identifier }, { matchTrackerUrl = () => null } = {}) => {
  const stored = storedLinks(metadata);
  if (url) {
    const id = buildLinkEntry({ url, title: 'unlink', kind: 'issue' }, 0, { matchTrackerUrl }).entry?.id;
    const address = comparableUrl(url);
    return stored.filter((entry) => entry.id === id || (address !== null && entry.url !== undefined && comparableUrl(entry.url) === address));
  }
  const wanted = identifier.toUpperCase();
  const isGitHubThread = (entry) => (entry.kind === 'issue' || entry.kind === 'pull')
    && entry.number !== undefined
    && parseHttpUrl(entry.url ?? '')?.hostname.replace(/^www\./, '').toLowerCase() === NATIVE_THREAD.host;
  return stored.filter((entry) => [
    entry.id,
    entry.identifier,
    isGitHubThread(entry) ? `#${entry.number}` : undefined,
  ].some((name) => name?.toUpperCase() === wanted));
};

const trimmedText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const createSessionLinker = ({ updateMetadata, createError, trackers = null, now = Date.now }) => {
  const link = async ({ sessionId, directory, link: input }) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const { entry, error } = buildLinkEntry(input, now(), { matchTrackerUrl: await trackerUrlMatcher(trackers) });
    if (error) throw createError(error, 400);

    const { changed } = await updateMetadata(sessionId, (current) => buildLinkPatch(current, entry), { directory: directory ?? '' });
    return { sessionId, linked: entry, changed };
  };

  const unlink = async ({ sessionId, directory, target }) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const url = trimmedText(target?.url);
    const identifier = trimmedText(target?.identifier);
    if (!url && !identifier) throw createError('Name the link to remove by url or identifier, the way it was linked', 400);
    const matchTrackerUrl = url ? await trackerUrlMatcher(trackers) : undefined;

    let matches = [];
    let linkedUrls = [];
    const { changed } = await updateMetadata(sessionId, (current) => {
      matches = findLinkedEntries(current, { url, identifier }, { matchTrackerUrl });
      if (matches.length === 0) {
        linkedUrls = storedLinks(current).map((entry) => entry.url ?? entry.id);
        return null;
      }
      if (!url && matches.length > 1) return null;
      return buildLinkedIssuesPatch(current, matches, false);
    }, { directory: directory ?? '' });

    if (matches.length === 0) {
      throw createError(`No link on this session matches ${url ?? identifier}. Linked: ${linkedUrls.join(', ') || 'nothing'}`, 404);
    }
    if (!url && matches.length > 1) {
      throw createError(`${identifier} names ${matches.length} links: ${matches.map((entry) => entry.url ?? entry.id).join(', ')}. Pass url to pick one; nothing was removed`, 409);
    }
    const unlinked = matches.map(({ id, number, title, url: address, kind }) => ({ id, number, title, url: address, kind }));
    return { sessionId, unlinked, changed };
  };

  return { link, unlink };
};
