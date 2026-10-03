import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

// Full-text search over the server's conversations
// (packages/web/server/lib/message-search). The server keeps the index; this
// module asks it and parses the answer once, at the boundary.

// Snippets mark each match with these private-use characters (server
// store.js). They are split here, never rendered as markup.
export const MATCH_START = '';
export const MATCH_END = '';

export const MIN_QUERY_TERM_LENGTH = 3;

const hitSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  /** `reasoning`: the match is in the agent's reasoning of message `id`. */
  role: z.enum(['user', 'assistant', 'reasoning']),
  createdAt: z.number(),
  sessionTitle: z.string(),
  directory: z.string(),
  snippet: z.string(),
});

const indexSchema = z.object({
  backfill: z.object({ state: z.enum(['idle', 'running', 'done']), total: z.number(), done: z.number() }),
  sessions: z.number(),
  messages: z.number(),
}).nullable();

const responseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), hits: z.array(hitSchema), next: z.string().nullable(), index: indexSchema }),
  z.object({ status: z.literal('query-too-short') }),
]);

export type MessageSearchHit = z.infer<typeof hitSchema>;
export type MessageSearchRole = MessageSearchHit['role'];
export type MessageSearchIndexStatus = NonNullable<z.infer<typeof indexSchema>>;

type MessageSearchResult =
  | { status: 'ok'; hits: MessageSearchHit[]; next: string | null; index: MessageSearchIndexStatus | null }
  | { status: 'query-too-short' }
  /** This server keeps no index (no SQLite builtin, or a server without the route). */
  | { status: 'unavailable' };

type MessageSearchRequest = {
  query: string;
  sessionId?: string | null;
  directories?: readonly string[];
  role?: MessageSearchRole | null;
  /** False leaves reasoning hits out, e.g. while the reader hides reasoning. */
  includeReasoning?: boolean;
  order?: 'asc' | 'desc';
  before?: string | null;
  limit: number;
  signal?: AbortSignal;
};

/** True when the query has a word the index can look up (3+ characters). */
export const isSearchableQuery = (query: string): boolean => (
  query.trim().split(/\s+/).some((term) => Array.from(term).length >= MIN_QUERY_TERM_LENGTH)
);

/**
 * Asks the server. A failed request throws: it is not an empty result, and a
 * caller showing "nothing found" for a network error would be lying.
 */
export const searchMessages = async (request: MessageSearchRequest): Promise<MessageSearchResult> => {
  const params = new URLSearchParams({ q: request.query, limit: String(request.limit) });
  if (request.sessionId) params.set('session', request.sessionId);
  for (const directory of request.directories ?? []) params.append('directory', directory);
  if (request.role) params.set('role', request.role);
  if (request.includeReasoning === false) params.set('reasoning', '0');
  if (request.order) params.set('order', request.order);
  if (request.before) params.set('before', request.before);
  const response = await runtimeFetch(`/api/openchamber/message-search?${params.toString()}`, { signal: request.signal });
  if (response.status === 503 || response.status === 404) return { status: 'unavailable' };
  if (!response.ok) throw new Error(`Message search failed (${response.status})`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Message search answered in an unknown shape');
  return parsed.data;
};

const statusSchema = z.object({
  state: z.enum(['unsupported', 'off', 'on', 'failed']),
  sizeBytes: z.number(),
  index: indexSchema,
});

export type MessageSearchServerStatus = z.infer<typeof statusSchema>;

const parseStatus = async (response: Response): Promise<MessageSearchServerStatus> => {
  if (!response.ok) throw new Error(`Message search status failed (${response.status})`);
  const parsed = statusSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Message search status answered in an unknown shape');
  return parsed.data;
};

/** Whether this server keeps an index right now, how big it is, how far indexing got. */
export const readMessageSearchStatus = async (signal?: AbortSignal): Promise<MessageSearchServerStatus> => (
  parseStatus(await runtimeFetch('/api/openchamber/message-search/status', { signal }))
);

/** Deletes the index file; while search is on the server starts a new one at once. */
export const deleteMessageSearchIndex = async (): Promise<MessageSearchServerStatus> => (
  parseStatus(await runtimeFetch('/api/openchamber/message-search/index', { method: 'DELETE' }))
);

type SnippetSegment = { text: string; match: boolean };

/** A snippet as plain-text runs, the matched ones flagged. */
export const splitSnippet = (snippet: string): SnippetSegment[] => {
  const segments: SnippetSegment[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(MATCH_START);
    if (start < 0) {
      segments.push({ text: rest, match: false });
      break;
    }
    if (start > 0) segments.push({ text: rest.slice(0, start), match: false });
    const end = rest.indexOf(MATCH_END, start + 1);
    const matched = rest.slice(start + 1, end < 0 ? undefined : end);
    if (matched) segments.push({ text: matched, match: true });
    rest = end < 0 ? '' : rest.slice(end + 1);
  }
  return segments;
};
