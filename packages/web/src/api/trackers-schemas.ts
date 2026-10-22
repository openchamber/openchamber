/**
 * The neutral tracker shapes as `/api/tracker/:provider/*` answers them,
 * parsed once here so the UI gets trusted values. One malformed entry in a
 * list is dropped, never the list; a value a newer server may send reads as
 * its closest known meaning (an unknown state category or priority as none).
 */
import { z } from 'zod';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import type {
  TrackerAccount,
  TrackerAuthStart,
  TrackerAuthStatus,
  TrackerComment,
  TrackerItem,
  TrackerItemResult,
  TrackerItemSummary,
  TrackerListResult,
  TrackerMappingResult,
  TrackerPerson,
  TrackerPreferences,
  TrackerSessionStatusPostResult,
  TrackerStatesResult,
  TrackerWorkflowState,
} from '@openchamber/ui/lib/api/types';

export type TrackerFetch = (input: string, init?: RuntimeFetchOptions) => Promise<Response>;

export type TrackerRequest = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: string };

const errorSchema = z.object({ error: z.string() });

/** A failed request as an error: the server's own message when it gave one, else the status text, else `fallback`. */
export const failureOf = async (response: Response, fallback: string): Promise<Error> => {
  const failure = errorSchema.safeParse(await response.json().catch(() => null));
  return new Error((failure.success && failure.data.error.trim()) || response.statusText || fallback);
};

/** Sends one request and parses its JSON answer; rejects on a failed or unreadable answer, never answers empty for it. */
export async function requestJson<T>(fetch: TrackerFetch, path: string, request: TrackerRequest, schema: z.ZodType<T>, failure: string): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  if (request.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { method: request.method, body: request.body, headers });
  if (!response.ok) throw await failureOf(response, failure);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error(`${failure}: unreadable answer`);
  return parsed.data;
}

const text = z.string().trim().min(1);
const optionalText = z.string().trim().nullish().catch(null).transform((value) => value || null);

const categorySchema = z.enum(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);
const prioritySchema = z.enum(['none', 'urgent', 'high', 'medium', 'low']);

/** Keeps the entries that parse; a list that is not an array is empty. */
const listOf = <T>(schema: z.ZodType<T>) => z.array(z.unknown()).catch([]).transform((values) => values.flatMap((value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [parsed.data] : [];
}));

const personSchema: z.ZodType<TrackerPerson | null> = z.object({ name: optionalText, avatarUrl: optionalText })
  .nullish()
  .catch(null)
  .transform((person) => (person && (person.name || person.avatarUrl) ? person : null));

const labelColor = z.string().nullish().catch(null).transform((value) => {
  const hex = value?.trim().replace(/^#/, '') ?? '';
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
});

const stateSchema = z.object({
  id: optionalText,
  name: z.string().trim().catch(''),
  category: categorySchema.nullable().catch(null),
}).nullish().catch(null).transform((state) => state ?? null);

const progressSchema = z.object({ total: z.number().int().positive(), done: z.number(), more: z.boolean().catch(false) })
  .nullish()
  .catch(null)
  .transform((progress) => (progress ? { ...progress, done: Math.min(Math.max(progress.done, 0), progress.total) } : null));

const summaryFields = {
  provider: text,
  id: text,
  identifier: text,
  title: text,
  url: text,
  state: stateSchema,
  priority: prioritySchema.nullish().catch(null),
  assignee: personSchema.optional(),
  container: z.object({ id: text, key: optionalText, name: text }).nullish().catch(null),
  updatedAt: optionalText.optional(),
};

/** A parent or a child: the item's own fields, without labels or relations. */
const relatedSchema: z.ZodType<TrackerItemSummary> = z.object(summaryFields);

const summaryObject = z.object({
  ...summaryFields,
  // Absent means the tracker was not asked; that stays absent rather than empty.
  labels: listOf(z.object({ id: text, name: text, color: labelColor })).optional(),
  parent: relatedSchema.nullish().catch(null),
  progress: progressSchema.optional(),
});
const summarySchema: z.ZodType<TrackerItemSummary> = summaryObject;

const commentSchema: z.ZodType<TrackerComment> = z.object({
  id: text,
  body: z.string().catch(''),
  createdAt: optionalText,
  author: personSchema,
});

const itemSchema: z.ZodType<TrackerItem> = summaryObject.extend({
  description: z.string().nullish().catch(null).transform((value) => value ?? null),
  comments: listOf(commentSchema),
  children: listOf(relatedSchema),
  childrenMore: z.boolean().catch(false),
});

export const disconnected = z.object({ connected: z.literal(false) }).transform(() => ({ connected: false as const }));

export const listResultSchema: z.ZodType<TrackerListResult> = z.union([
  disconnected,
  z.object({
    connected: z.literal(true),
    items: listOf(summarySchema),
    cursor: optionalText,
    hasMore: z.boolean().catch(false),
  }),
]);

export const itemResultSchema: z.ZodType<TrackerItemResult> = z.union([
  disconnected,
  z.object({ connected: z.literal(true), item: itemSchema.nullish().catch(null).transform((item) => item ?? null) }),
]);

const workflowStateSchema: z.ZodType<TrackerWorkflowState> = z.object({
  id: text,
  name: text,
  category: categorySchema.nullable().catch(null),
  position: z.number().catch(0),
});

export const statesResultSchema: z.ZodType<TrackerStatesResult> = z.union([
  disconnected,
  z.object({ connected: z.literal(true), states: listOf(workflowStateSchema) }),
]);

const accountSchema: z.ZodType<TrackerAccount> = z.object({
  id: text,
  name: optionalText,
  user: personSchema.optional(),
  current: z.boolean().catch(false),
  authorizedAt: z.number().nullish().catch(null),
});

export const authStatusSchema: z.ZodType<TrackerAuthStatus> = z.union([
  disconnected,
  z.object({
    connected: z.literal(true),
    account: accountSchema.nullish().catch(null),
    accounts: listOf(accountSchema),
  }),
]);

export const authStartSchema: z.ZodType<TrackerAuthStart> = z.object({
  authorizationUrl: text,
  expiresIn: z.number().positive(),
});

export const mappingResultSchema: z.ZodType<TrackerMappingResult> = z.union([
  disconnected,
  z.object({
    connected: z.literal(true),
    defaultProjectPath: optionalText,
    containers: listOf(z.object({ id: text, key: optionalText, name: text, projectPath: optionalText })),
  }),
]);

export const preferencesSchema: z.ZodType<TrackerPreferences> = z.object({ sessionComments: z.boolean() });

export const sessionStatusResultSchema: z.ZodType<TrackerSessionStatusPostResult> = z.union([
  disconnected,
  z.object({ connected: z.literal(true), posted: z.literal(true), commentId: optionalText }),
  z.object({
    connected: z.literal(true),
    posted: z.literal(false),
    skipped: z.enum(['already-posted', 'issue-not-found', 'not-started', 'disabled', 'origin-not-public']),
  }),
]);
