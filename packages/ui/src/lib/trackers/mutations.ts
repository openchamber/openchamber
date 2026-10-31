import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import type { TrackerCreateItemInput, TrackerEditItemInput, TrackerItem, TrackerProviderId } from './types';

/**
 * The board's item mutations: `POST /api/tracker/:provider/items/create` and
 * `/items/edit`, the two writes the descriptor's `create`/`edit` capability
 * bits gate. The reads go through `RuntimeAPIs.trackers` (the web adapter in
 * `packages/web/src/api/trackers.ts`); these writes ride the same
 * `runtimeFetch` auth path that adapter uses.
 *
 * Both reject on failure — a non-2xx answer, and a 2xx that does not carry an
 * item — so a failed write never reaches the caller as a success.
 */

const text = z.string().trim().min(1);
const optionalText = z.string().trim().nullish().catch(null).transform((value) => value || null);
const prioritySchema = z.enum(['none', 'urgent', 'high', 'medium', 'low']);
const categorySchema = z.enum(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);

/** The item fields the dialog reads back; the tracker's own extras are not kept. */
const itemSchema = z.object({
  provider: text,
  id: text,
  identifier: text,
  title: text,
  url: z.string(),
  state: z.object({
    id: optionalText,
    name: z.string().catch(''),
    category: categorySchema.nullable().catch(null),
  }).nullish().catch(null).transform((state) => state ?? null),
  priority: prioritySchema.nullish().catch(null),
  description: z.string().nullish().catch(null).transform((value) => value ?? null),
  labels: z.array(z.object({ id: text, name: text, color: z.string().nullish().catch(null).transform((color) => color ?? null) }))
    .nullish()
    .catch(undefined)
    .transform((labels) => labels ?? undefined),
}) satisfies z.ZodType<TrackerItem>;

const errorSchema = z.object({ error: z.string() });

/** A failed request as an error: the server's own message when it gave one, else `fallback` with the status. */
const failureOf = async (response: Response, fallback: string): Promise<never> => {
  const answer = errorSchema.safeParse(await response.json().catch(() => null));
  throw new Error((answer.success && answer.data.error.trim()) || `${fallback} (${response.status})`);
};

/** The routes answer `{ connected, item }`; `connected: false` is a failure, not an empty success. */
const itemResultSchema = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({ connected: z.literal(true), item: itemSchema.nullable().catch(null) }),
]);

const postItem = async (
  provider: TrackerProviderId,
  path: string,
  body: TrackerCreateItemInput | TrackerEditItemInput,
  fallback: string,
): Promise<TrackerItem> => {
  const response = await runtimeFetch(`/api/tracker/${encodeURIComponent(provider)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) await failureOf(response, fallback);
  const result = itemResultSchema.safeParse(await response.json().catch(() => null));
  if (!result.success || !result.data.connected || result.data.item === null) {
    throw new Error(`${fallback}: unreadable answer`);
  }
  return result.data.item;
};

/** Creates an item in one of the tracker's containers; the tracker names it. */
export const createTrackerItem = (provider: TrackerProviderId, input: TrackerCreateItemInput): Promise<TrackerItem> => (
  postItem(provider, '/items/create', input, 'Failed to create the tracker item')
);

/** Edits an item's fields; the tracker leaves a field the input omits alone. */
export const editTrackerItem = (provider: TrackerProviderId, input: TrackerEditItemInput): Promise<TrackerItem> => (
  postItem(provider, '/items/edit', input, 'Failed to save the tracker item')
);
