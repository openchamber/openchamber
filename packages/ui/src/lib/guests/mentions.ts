import type { AttachIssueRequest, MentionsItem } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

import { isGuestActive } from './capabilities';
import type { InstalledGuest } from './types';

/** One row of an extension's section in the `@` menu. */
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

/** The rows every extension gave for `query`; a failed search lists none, and files stay in the menu. */
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

/**
 * The chip a picked row becomes, its context read now. `null` when the
 * extension cannot give it: no chip appears, since a message with the row's
 * name and none of its content is not what the user chose.
 */
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
