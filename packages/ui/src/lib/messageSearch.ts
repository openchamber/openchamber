import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import type { MatchSegment } from '@/lib/search/matchSegments';
import type { OmniLifecycle } from '@/lib/search/omniQuery';


export const MATCH_START = '';
export const MATCH_END = '';

export const MIN_QUERY_TERM_LENGTH = 3;

const hitSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'reasoning']),
  createdAt: z.number(),
  sessionTitle: z.string(),
  directory: z.string(),
  snippet: z.string(),
  archived: z.boolean().optional(),
  matchCount: z.number().int().nonnegative().optional(),
});

const indexSchema = z.object({
  backfill: z.object({ state: z.enum(['idle', 'running', 'done']), total: z.number(), done: z.number() }),
  sessions: z.number(),
  messages: z.number(),
  lifecycleComplete: z.boolean().optional().default(true),
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
  | { status: 'unavailable' };

type MessageSearchRequest = {
  query: string;
  sessionId?: string | null;
  directories?: readonly string[];
  role?: MessageSearchRole | null;
  includeReasoning?: boolean;
  order?: 'asc' | 'desc';
  before?: string | null;
  limit: number;
  signal?: AbortSignal;
  lifecycle?: OmniLifecycle;
};

const conversationHitSchema = z.object({
  sessionId: z.string().min(1), sessionTitle: z.string(), directory: z.string(), archived: z.boolean().optional().default(false),
  messageId: z.string().min(1), role: z.enum(['user', 'assistant', 'reasoning']), createdAt: z.number(), snippet: z.string(), matchCount: z.number(),
});
const conversationResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), hits: z.array(conversationHitSchema), next: z.string().nullable(), totals: z.object({ sessions: z.number(), byDirectory: z.record(z.string(), z.number()) }).nullable().optional().default(null), index: indexSchema }),
  z.object({ status: z.literal('query-too-short') }),
]);
export type ConversationContentHit = z.infer<typeof conversationHitSchema>;
type ConversationContentResult =
  | { status: 'ok'; hits: ConversationContentHit[]; next: string | null; totals: { sessions: number; byDirectory: Record<string, number> } | null; index: MessageSearchIndexStatus | null }
  | { status: 'query-too-short' } | { status: 'unavailable' };
type ConversationSearchRequest = { query: string; lifecycle: OmniLifecycle; directories?: readonly string[]; exclude?: readonly string[]; role?: MessageSearchRole | null; includeReasoning?: boolean; before?: string | null; limit: number; signal?: AbortSignal };

export const isSearchableQuery = (query: string): boolean => (
  query.trim().split(/\s+/).some((term) => Array.from(term).length >= MIN_QUERY_TERM_LENGTH)
);

export const searchMessages = async (request: MessageSearchRequest): Promise<MessageSearchResult> => {
  const params = new URLSearchParams({ q: request.query, limit: String(request.limit) });
  if (request.sessionId) params.set('session', request.sessionId);
  for (const directory of request.directories ?? []) params.append('directory', directory);
  if (request.role) params.set('role', request.role);
  if (request.includeReasoning === false) params.set('reasoning', '0');
  if (request.order) params.set('order', request.order);
  if (request.before) params.set('before', request.before);
  if (request.lifecycle) params.set('lifecycle', request.lifecycle);
  const response = await runtimeFetch(`/api/openchamber/message-search?${params.toString()}`, { signal: request.signal });
  if (response.status === 503 || response.status === 404) return { status: 'unavailable' };
  if (!response.ok) throw new Error(`Message search failed (${response.status})`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Message search answered in an unknown shape');
  return parsed.data;
};

export const searchConversations = async (request: ConversationSearchRequest): Promise<ConversationContentResult> => {
  const params = new URLSearchParams({ q: request.query, lifecycle: request.lifecycle, limit: String(request.limit) });
  for (const directory of request.directories ?? []) params.append('directory', directory);
  for (const sessionId of request.exclude ?? []) params.append('exclude', sessionId);
  if (request.role) params.set('role', request.role);
  if (request.includeReasoning === false) params.set('reasoning', '0');
  if (request.before) params.set('before', request.before);
  const response = await runtimeFetch(`/api/openchamber/message-search/sessions?${params}`, { signal: request.signal });
  if (response.status === 503 || response.status === 404) return { status: 'unavailable' };
  if (!response.ok) throw new Error(`Conversation search failed (${response.status})`);
  const parsed = conversationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Conversation search answered in an unknown shape');
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

export const readMessageSearchStatus = async (signal?: AbortSignal): Promise<MessageSearchServerStatus> => (
  parseStatus(await runtimeFetch('/api/openchamber/message-search/status', { signal }))
);

export const deleteMessageSearchIndex = async (): Promise<MessageSearchServerStatus> => (
  parseStatus(await runtimeFetch('/api/openchamber/message-search/index', { method: 'DELETE' }))
);

export const splitSnippet = (snippet: string): MatchSegment[] => {
  const segments: MatchSegment[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(MATCH_START);
    if (start < 0) {
      segments.push({ text: rest, matched: false });
      break;
    }
    if (start > 0) segments.push({ text: rest.slice(0, start), matched: false });
    const end = rest.indexOf(MATCH_END, start + 1);
    const matched = rest.slice(start + 1, end < 0 ? undefined : end);
    if (matched) segments.push({ text: matched, matched: true });
    rest = end < 0 ? '' : rest.slice(end + 1);
  }
  return segments;
};

export const leadWithMatch = (segments: MatchSegment[], lead = 20): MatchSegment[] => {
  const first = segments[0];
  if (!first || first.matched || segments.length < 2 || first.text.length <= lead) return segments;
  const tail = first.text.slice(-lead);
  const space = tail.indexOf(' ');
  const kept = space >= 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
  return [{ text: `…${kept}`, matched: false }, ...segments.slice(1)];
};
