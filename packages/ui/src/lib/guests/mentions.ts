import type { AttachIssueRequest, MentionsItem } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

import { isGuestActive } from './capabilities';
import type { InstalledGuest } from './types';

export type GuestMention = MentionsItem & { guestId: string; label: string };

const searchAnswerSchema = z.object({
  groups: z.array(z.object({
    guestId: z.string(),
    label: z.string(),
    items: z.array(z.object({ id: z.string(), title: z.string(), subtitle: z.string().optional(), url: z.string().optional() })),
  })),
});

const resolveAnswerSchema = z.object({ text: z.string().min(1) });

export const guestsOfferMentions = (guests: InstalledGuest[]): boolean => guests.some((guest) => guest.mentions && isGuestActive(guest));

export const searchGuestMentions = async (query: string, directory: string | null, signal: AbortSignal): Promise<GuestMention[]> => {
  const response = await runtimeFetch('/api/guests/mentions/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, directory }),
    signal,
  }).catch(() => null);
  if (!response?.ok) return [];
  const parsed = searchAnswerSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return [];
  return parsed.data.groups.flatMap(({ guestId, label, items }) => items.map((item) => ({ ...item, guestId, label })));
};

export const resolveGuestMention = async (mention: GuestMention): Promise<AttachIssueRequest | null> => {
  const response = await runtimeFetch(`/api/guests/${encodeURIComponent(mention.guestId)}/mentions/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: mention.id }),
  }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = resolveAnswerSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;
  return { providerId: mention.guestId, id: mention.id, title: mention.title, url: mention.url ?? '', text: parsed.data.text };
};
