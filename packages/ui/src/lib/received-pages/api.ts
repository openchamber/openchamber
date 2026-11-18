import { z } from 'zod';

import type { JsonValue } from '@/lib/opencode/model';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { shareRequestFailure } from '@/lib/share-pages/api';


const BASE = '/api/openchamber/received-pages';

const RECEIVED_PAGE_STATUSES = ['open', 'locked', 'answered', 'expired', 'cancelled', 'missing'] as const;

const optionalText = z.string().nullish().catch(null).transform((value) => value || null);

const receivedPageSchema = z.object({
  receivedId: z.string().min(1),
  host: z.string(),
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
  pinRejected: z.boolean().optional().catch(undefined),
});

export type ReceivedPage = z.infer<typeof receivedPageSchema>;

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

export async function fetchReceivedPagesConfig(): Promise<ReceivedPagesConfig> {
  const response = await runtimeFetch(`${BASE}/config`);
  if (!response.ok) throw await shareRequestFailure(response, 'Could not read the shared pages settings');
  return configSchema.parse(await response.json());
}

export async function fetchReceivedPages(): Promise<ReceivedPageItem[]> {
  const response = await runtimeFetch(BASE);
  if (!response.ok) throw await shareRequestFailure(response, 'Could not read the shared pages');
  const { pages } = receivedPageListSchema.parse(await response.json());
  return pages.flatMap((entry) => {
    const page = receivedPageItemSchema.safeParse(entry);
    return page.success ? [page.data] : [];
  });
}

export async function registerReceivedPage(url: string): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(BASE, json({ url })), 'Could not read the share link');
}

export async function fetchReceivedPage(receivedId: string): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(pagePath(receivedId)), 'Could not read the shared page');
}

export async function refreshReceivedPage(receivedId: string): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(pagePath(receivedId, '/status'), { method: 'POST' }), 'Could not read the shared page');
}

export async function openReceivedPage(receivedId: string, pin: string): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(pagePath(receivedId, '/open'), json({ pin })), 'Could not open the shared page');
}

const documentSchema = z.object({ html: z.string() });

export async function fetchReceivedPageDocument(receivedId: string): Promise<string> {
  const response = await runtimeFetch(pagePath(receivedId, '/document'));
  if (!response.ok) throw await shareRequestFailure(response, 'Could not read the shared page');
  return documentSchema.parse(await response.json()).html;
}

export async function answerReceivedPage(receivedId: string, answer: { data: JsonValue; summary: string }): Promise<ReceivedPage> {
  return readPage(await runtimeFetch(pagePath(receivedId, '/answer'), json(answer)), 'Could not send the answer');
}
