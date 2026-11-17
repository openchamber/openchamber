import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';


const SHARE_RECIPIENT_STATUSES = ['preparing', 'open', 'locked', 'answered', 'expired', 'cancelled', 'failed'] as const;

const optionalText = z.string().nullish().catch(null).transform((value) => value || null);
const optionalTime = z.number().finite().nullish().catch(null).transform((value) => value ?? null);

const recipientSchema = z.object({
  recipientId: z.string().min(1),
  label: z.string(),
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

export class SharePageRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

export const shareRequestFailure = async (response: Response, fallback: string): Promise<SharePageRequestError> => {
  const payload = errorSchema.parse(await response.json().catch(() => null));
  return new SharePageRequestError(payload.error || `${fallback} (${response.status})`, response.status, payload.code ?? null);
};

export const isSharingTurnedOff = (error: Error): boolean => (
  error instanceof SharePageRequestError && error.status === 403 && error.code === 'enterprise_mode'
);

const groupPath = (sessionId: string, callId: string) => (
  `/api/openchamber/sessions/${encodeURIComponent(sessionId)}/share-pages/${encodeURIComponent(callId)}`
);

export async function fetchSharePageGroup(sessionId: string, callId: string): Promise<SharePageGroup> {
  const response = await runtimeFetch(groupPath(sessionId, callId));
  if (!response.ok) throw await shareRequestFailure(response, 'Could not read the shared page');
  return sharePageGroupSchema.parse(await response.json());
}

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

export async function cancelSharePageRecipient(sessionId: string, callId: string, recipientId: string): Promise<SharePageGroup | null> {
  const response = await runtimeFetch(`${groupPath(sessionId, callId)}/recipients/${encodeURIComponent(recipientId)}/cancel`, { method: 'POST' });
  if (!response.ok) throw await shareRequestFailure(response, 'Could not cancel the link');
  return sharePageGroupSchema.safeParse(await response.json().catch(() => null)).data ?? null;
}

const previewSchema = z.object({ html: z.string().min(1) });

export async function fetchSharePagePreview(sessionId: string, callId: string): Promise<string> {
  const response = await runtimeFetch(`${groupPath(sessionId, callId)}/preview`);
  if (!response.ok) throw await shareRequestFailure(response, 'Could not open the shared page');
  return previewSchema.parse(await response.json()).html;
}
