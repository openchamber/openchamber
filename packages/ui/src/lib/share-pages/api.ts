import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * A page an agent shared with other people (`openchamber_render` with
 * `share`), as the OpenChamber server keeps it: one group per tool call, one
 * relay link and PIN per recipient. The server owns the state (links, PINs,
 * openings, answers); the chat card reads it here and never from the call,
 * since the agent's result carries no links or PINs.
 *
 * Routes (`/api/openchamber/sessions/:sessionId/share-pages/:callId`):
 * `GET` the group, `POST …/document` the self-contained page to encrypt and
 * upload, `POST …/recipients/:recipientId/cancel`, `GET …/preview`.
 */

const SHARE_RECIPIENT_STATUSES = ['preparing', 'open', 'locked', 'answered', 'expired', 'cancelled', 'failed'] as const;

const optionalText = z.string().nullish().catch(null).transform((value) => value || null);
const optionalTime = z.number().finite().nullish().catch(null).transform((value) => value ?? null);

const recipientSchema = z.object({
  recipientId: z.string().min(1),
  label: z.string(),
  // A status this client does not know yet reads as one that needs nothing from it.
  status: z.enum(SHARE_RECIPIENT_STATUSES).catch('preparing'),
  link: optionalText,
  pin: optionalText,
  opens: z.array(z.number().finite()).catch([]),
  answeredAt: optionalTime,
  answerSummary: optionalText,
  error: optionalText,
});

export type ShareRecipient = z.infer<typeof recipientSchema>;

const sharePageGroupSchema = z.object({
  title: z.string().catch(''),
  kind: z.string().catch(''),
  expectAnswer: z.boolean().catch(true),
  summary: optionalText,
  expiresAt: optionalTime,
  documentState: z.enum(['preparing', 'ready']).catch('ready'),
  recipients: z.array(recipientSchema),
});

export type SharePageGroup = z.infer<typeof sharePageGroupSchema>;

const errorSchema = z.object({ error: z.string().min(1), code: z.string().min(1).optional() }).catch({ error: '' });

/**
 * A failed request: the server's message when it sent one, the status (404
 * means the server has no such group) and the server's error code.
 */
export class SharePageRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

export const shareRequestFailure = async (response: Response, fallback: string): Promise<SharePageRequestError> => {
  const payload = errorSchema.parse(await response.json().catch(() => null));
  return new SharePageRequestError(payload.error || `${fallback} (${response.status})`, response.status, payload.code ?? null);
};

/**
 * Whether the server refused because enterprise mode allows no relay
 * (decision 0005): every share route answers 403 `enterprise_mode` then, and
 * the chat shows no links, PINs or preview.
 */
export const isSharingTurnedOff = (error: Error): boolean => (
  error instanceof SharePageRequestError && error.status === 403 && error.code === 'enterprise_mode'
);

const groupPath = (sessionId: string, callId: string) => (
  `/api/openchamber/sessions/${encodeURIComponent(sessionId)}/share-pages/${encodeURIComponent(callId)}`
);

/** The group of one share call. Throws on any failure, so a missing answer never reads as an empty group. */
export async function fetchSharePageGroup(sessionId: string, callId: string): Promise<SharePageGroup> {
  const response = await runtimeFetch(groupPath(sessionId, callId));
  if (!response.ok) throw await shareRequestFailure(response, 'Could not read the shared page');
  return sharePageGroupSchema.parse(await response.json());
}

/**
 * Hands the server the page every recipient gets; it encrypts and uploads it
 * for each recipient not uploaded yet or failed, and answers with the group.
 */
/**
 * What a shared page is made from, sealed with its document so a recipient's
 * own agent reads content instead of the themed page: the `ui` program, or
 * the agent's HTML with its share summary. The relay's viewer ignores it.
 */
export type SharePageSource = { format: 'ui' | 'html'; text: string; summary: string | null };

export async function postSharePageDocument(sessionId: string, callId: string, document: { html: string; title: string; source: SharePageSource }): Promise<SharePageGroup> {
  const response = await runtimeFetch(`${groupPath(sessionId, callId)}/document`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(document),
  });
  if (!response.ok) throw await shareRequestFailure(response, 'Could not upload the shared page');
  return sharePageGroupSchema.parse(await response.json());
}

/** Withdraws one recipient's link. Answers with the group when the server sends it, else null. */
export async function cancelSharePageRecipient(sessionId: string, callId: string, recipientId: string): Promise<SharePageGroup | null> {
  const response = await runtimeFetch(`${groupPath(sessionId, callId)}/recipients/${encodeURIComponent(recipientId)}/cancel`, { method: 'POST' });
  if (!response.ok) throw await shareRequestFailure(response, 'Could not cancel the link');
  return sharePageGroupSchema.safeParse(await response.json().catch(() => null)).data ?? null;
}

const previewSchema = z.object({ html: z.string().min(1) });

/** The page as the recipients get it, from the copy the server keeps; it never goes through the relay. */
export async function fetchSharePagePreview(sessionId: string, callId: string): Promise<string> {
  const response = await runtimeFetch(`${groupPath(sessionId, callId)}/preview`);
  if (!response.ok) throw await shareRequestFailure(response, 'Could not open the shared page');
  return previewSchema.parse(await response.json()).html;
}
