import { z } from 'zod';

import type { JsonValue } from '@/lib/opencode/model';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { shareRequestFailure } from '@/lib/share-pages/api';

/**
 * Pages other people shared by link and PIN, opened in this app (decision
 * 0013). The OpenChamber server keeps the link's key and makes every relay
 * call; the client hands the link over once and from then on knows the page
 * by `receivedId`, so no key or PIN is ever held here or written to a draft.
 *
 * Routes (`/api/openchamber/received-pages`): `GET /config`, `POST /` with
 * the link, `GET /:id`, `POST /:id/status`, `POST /:id/open` with the PIN,
 * `GET /:id/document`, `POST /:id/answer`. Every route but `config` answers
 * 403 `enterprise_mode` while receiving is unavailable (`isSharingTurnedOff`).
 */

const BASE = '/api/openchamber/received-pages';

const RECEIVED_PAGE_STATUSES = ['open', 'locked', 'answered', 'expired', 'cancelled', 'missing'] as const;

const optionalText = z.string().nullish().catch(null).transform((value) => value || null);

const receivedPageSchema = z.object({
  receivedId: z.string().min(1),
  host: z.string(),
  // A status this client does not know yet reads as one that takes nothing from it.
  status: z.enum(RECEIVED_PAGE_STATUSES).catch('missing'),
  kind: optionalText,
  wantsAnswer: z.boolean().catch(false),
  expiresAt: z.number().finite().nullish().catch(null).transform((value) => value ?? null),
  attemptsLeft: z.number().finite().nullish().catch(null).transform((value) => value ?? null),
  opened: z.boolean().catch(false),
  title: optionalText,
  source: z.object({
    format: z.enum(['ui', 'html']),
    text: z.string(),
    summary: optionalText,
  }).nullish().catch(null).transform((value) => value ?? null),
  answer: z.object({
    summary: z.string(),
    data: z.json().catch(null),
    submittedAt: z.number().finite(),
  }).nullish().catch(null).transform((value) => value ?? null),
  // Only on the answer to a refused PIN.
  pinRejected: z.boolean().optional().catch(undefined),
});

export type ReceivedPage = z.infer<typeof receivedPageSchema>;

// A row of the received pages list: the page's view without its source, and
// of the answer only what was sent in words.
const receivedPageItemSchema = receivedPageSchema.omit({ source: true, answer: true, pinRejected: true }).extend({
  createdAt: z.number().finite().catch(0),
  answer: z.object({ summary: z.string(), submittedAt: z.number().finite() }).nullish().catch(null).transform((value) => value ?? null),
});

export type ReceivedPageItem = z.infer<typeof receivedPageItemSchema>;

const receivedPageListSchema = z.object({ pages: z.array(z.unknown()) });

const configSchema = z.object({
  available: z.boolean().catch(false),
  bases: z.array(z.string()).catch([]),
});

export type ReceivedPagesConfig = z.infer<typeof configSchema>;

const pagePath = (receivedId: string, suffix = '') => `${BASE}/${encodeURIComponent(receivedId)}${suffix}`;

const json = (body: Record<string, JsonValue>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const readPage = async (response: Response, fallback: string): Promise<ReceivedPage> => {
  if (!response.ok) throw await shareRequestFailure(response, fallback);
  return receivedPageSchema.parse(await response.json());
};

/** Which relays this server opens links on; `available: false` in enterprise mode without one. */
export async function fetchReceivedPagesConfig(): Promise<ReceivedPagesConfig> {
  const response = await runtimeFetch(`${BASE}/config`);
  if (!response.ok) throw await shareRequestFailure(response, 'Could not read the shared pages settings');
  return configSchema.parse(await response.json());
}

/**
 * Every page this server received, newest first. A row that does not parse is
 * left out, never the whole list; a failed read throws, so it never reads as
 * no pages.
 */
export async function fetchReceivedPages(): Promise<ReceivedPageItem[]> {
  const response = await runtimeFetch(BASE);
  if (!response.ok) throw await shareRequestFailure(response, 'Could not read the shared pages');
  const { pages } = receivedPageListSchema.parse(await response.json());
  return pages.flatMap((entry) => {
    const page = receivedPageItemSchema.safeParse(entry);
    return page.success ? [page.data] : [];
  });
}

/** Hands a pasted link to the server, which keeps its key; the share's state is read next (`refreshReceivedPage`). */
export async function registerReceivedPage(url: string): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(BASE, json({ url })), 'Could not read the share link');
}

export async function fetchReceivedPage(receivedId: string): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(pagePath(receivedId)), 'Could not read the shared page');
}

/** Asks the relay again whether the page is still open, locked, expired, answered or withdrawn. */
export async function refreshReceivedPage(receivedId: string): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(pagePath(receivedId, '/status'), { method: 'POST' }), 'Could not read the shared page');
}

/** Opens the page with its PIN; a wrong PIN answers the page with `pinRejected` and the attempts left. */
export async function openReceivedPage(receivedId: string, pin: string): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(pagePath(receivedId, '/open'), json({ pin })), 'Could not open the shared page');
}

const documentSchema = z.object({ html: z.string() });

/** The decrypted page as its author shared it. */
export async function fetchReceivedPageDocument(receivedId: string): Promise<string> {
  const response = await runtimeFetch(pagePath(receivedId, '/document'));
  if (!response.ok) throw await shareRequestFailure(response, 'Could not read the shared page');
  return documentSchema.parse(await response.json()).html;
}

/** Sends the one answer the page takes; the server seals it for the author. */
export async function answerReceivedPage(receivedId: string, answer: { data: JsonValue; summary: string }): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(pagePath(receivedId, '/answer'), json(answer)), 'Could not send the answer');
}
