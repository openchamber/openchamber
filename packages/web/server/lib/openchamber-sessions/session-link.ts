import { z } from 'zod';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import { buildLinkedIssuesPatch } from './session-linked-issues.js';
import type { TrackerRegistry, TrackerImplementation } from '../trackers/tracker-contract.js';
import type { LinkedIssuesPatch } from './session-linked-issues.js';
import type { JsonValue } from '@opencode/client';

export interface LinkEntry {
  id: string;
  title: string;
  url: string;
  kind: 'issue' | 'pull' | 'tracker' | 'linear' | 'external';
  linkedAt: number;
  number?: number;
  provider?: string;
  identifier?: string;
  thread?: 'change' | 'issue';
}

type LinkEntryResult = { entry: LinkEntry; error?: never } | { error: string; entry?: never };
type MatchTrackerUrl = (url: string) => { provider: string; identifier: string } | null;
interface LinkMatchOptions {
  matchTrackerUrl?: MatchTrackerUrl | undefined;
}
interface LinkerOptions {
  updateMetadata: (
    sessionId: string,
    decide: (current: JsonValue) => LinkedIssuesPatch | null,
    options: { directory: string },
  ) => Promise<{ changed: boolean }>;
  createError: (message: string, status: number) => Error;
  trackers?: TrackerRegistry | null;
  now?: () => number;
}
interface LinkRequest {
  sessionId: string | null | undefined;
  directory?: string | null | undefined;
  link: unknown;
}
interface UnlinkRequest {
  sessionId: string | null | undefined;
  directory?: string | null | undefined;
  target: { url?: JsonValue | undefined; identifier?: JsonValue | undefined } | null | undefined;
}

const MAX_TITLE_LENGTH = 300;
const MAX_IDENTIFIER_LENGTH = 64;

const NATIVE_THREAD = { provider: 'github', host: 'github.com' };

const linkInputSchema = z.object({
  url: z.string().trim().min(1),
  title: z.string().trim().min(1).transform((title) => title.slice(0, MAX_TITLE_LENGTH)),
  kind: z.enum(['change', 'issue']),
  identifier: z.string().trim().max(MAX_IDENTIFIER_LENGTH).optional(),
});

const parseHttpUrl = (value: string) => {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
};

const threadPathOf = (host: string, pathname: string) => {
  for (const descriptor of sourceControlProviderDescriptors.list()) {
    const { hosts, pattern } = descriptor.urls.thread;
    if (hosts !== 'any' && !hosts.includes(host)) continue;
    const match = pattern.exec(pathname);
    if (match) return { provider: descriptor.id, match };
  }
  return null;
};

const trackerEntryKind = (provider: string) => (provider === 'linear' ? 'linear' : 'tracker');

export const buildLinkEntry = (input: LinkRequest['link'], linkedAt: number, { matchTrackerUrl = () => null }: LinkMatchOptions = {}): LinkEntryResult => {
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

const SNAPSHOT_KEYS = ['number', 'identifier', 'title', 'url', 'kind', 'thread'] as const;

export const buildLinkPatch = (metadata: JsonValue | undefined, entry: LinkEntry): LinkedIssuesPatch | null => {
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

const trackerUrlMatcher = async (trackers: TrackerRegistry | null) => {
  const matchers: { provider: string; matchUrl: TrackerImplementation['matchUrl'] }[] = [];
  for (const provider of trackers?.list() ?? []) {
    try {
      const tracker = await trackers?.implementation(provider);
      if (tracker?.matchUrl instanceof Function) matchers.push({ provider, matchUrl: tracker.matchUrl });
    } catch { continue; }
  }
  return (url: string) => {
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

type StoredLink = z.infer<typeof storedLinkSchema>;

const comparableUrl = (value: string) => {
  const url = parseHttpUrl(value.trim());
  if (!url) return null;
  url.hash = '';
  return url.toString().replace(/\/+$/, '').toLowerCase();
};

const storedLinks = (metadata: JsonValue | undefined) => linkMetadataSchema.parse(metadata ?? {}).openchamber.linked_issues
  .flatMap((item) => {
    const parsed = storedLinkSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });

const findLinkedEntries = (metadata: JsonValue, { url, identifier }: { url: string | null; identifier: string | null }, { matchTrackerUrl = () => null }: LinkMatchOptions = {}) => {
  const stored = storedLinks(metadata);
  if (url) {
    const id = buildLinkEntry({ url, title: 'unlink', kind: 'issue' }, 0, { matchTrackerUrl }).entry?.id;
    const address = comparableUrl(url);
    return stored.filter((entry) => entry.id === id || (address !== null && entry.url !== undefined && comparableUrl(entry.url) === address));
  }
  const wanted = identifier?.toUpperCase();
  const isGitHubThread = (entry: StoredLink) => (entry.kind === 'issue' || entry.kind === 'pull')
    && entry.number !== undefined
    && parseHttpUrl(entry.url ?? '')?.hostname.replace(/^www\./, '').toLowerCase() === NATIVE_THREAD.host;
  return stored.filter((entry) => [
    entry.id,
    entry.identifier,
    isGitHubThread(entry) ? `#${entry.number}` : undefined,
  ].some((name) => name?.toUpperCase() === wanted));
};

const isText = (value: unknown): value is string => typeof value === 'string';
const trimmedText = (value: JsonValue | undefined) => (isText(value) && value.trim() ? value.trim() : null);

export const createSessionLinker = ({ updateMetadata, createError, trackers = null, now = Date.now }: LinkerOptions) => {
  const link = async ({ sessionId, directory, link: input }: LinkRequest) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const { entry, error } = buildLinkEntry(input, now(), { matchTrackerUrl: await trackerUrlMatcher(trackers) });
    if (error !== undefined) throw createError(error, 400);

    const { changed } = await updateMetadata(sessionId, (current) => buildLinkPatch(current, entry), { directory: directory ?? '' });
    return { sessionId, linked: entry, changed };
  };

  const unlink = async ({ sessionId, directory, target }: UnlinkRequest) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const url = trimmedText(target?.url);
    const identifier = trimmedText(target?.identifier);
    if (!url && !identifier) throw createError('Name the link to remove by url or identifier, the way it was linked', 400);
    const matchTrackerUrl = url ? await trackerUrlMatcher(trackers) : undefined;

    let matches: StoredLink[] = [];
    let linkedUrls: string[] = [];
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
