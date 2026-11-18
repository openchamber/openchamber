import {
  MENTIONS_IDLE_MS,
  MENTIONS_ITEMS_MAX,
  MENTIONS_RESOLVE_PATH,
  MENTIONS_RESOLVE_TIMEOUT_MS,
  MENTIONS_SEARCH_PATH,
  MENTIONS_SEARCH_TIMEOUT_MS,
  MENTION_TEXT_MAX,
  isGuestApproved,
  requestedGuestCapabilities,
} from '@openchamber/sdk';
import { mentionItemSchema, mentionsResolveResultSchema } from '@openchamber/sdk/schemas';

import { proxyGuestServiceRequest } from './service.js';
import type { GuestServiceRequest } from './service.js';
import type { GuestRecord, JsonValue } from './contracts.js';
import { isJsonObject } from './input-guards.js';


const RESOLVE_ANSWER_MAX = MENTION_TEXT_MAX * 6 + 1_024;
const SEARCH_ANSWER_MAX = 256_000;

export const isMentionGuest = (guest: GuestRecord) => guest.enabled !== false
  && guest.capabilityGrants?.includes('service') === true
  && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants });

type MentionGuest = GuestRecord & { service: NonNullable<GuestRecord['service']> };
type MentionParams = Pick<GuestServiceRequest, 'path' | 'body' | 'timeoutMs' | 'signal'> & { responseMax: number };

const askService = (guest: MentionGuest, persistPath: string, params: MentionParams, callService = proxyGuestServiceRequest) => callService({
  guestId: guest.id,
  guestName: guest.name,
  packageRoot: guest.packageRoot,
  service: guest.service,
  granted: guest.capabilityGrants,
  persistPath,
  method: 'POST',
  idleStopMs: guest.service.keepRunning ? undefined : MENTIONS_IDLE_MS,
  ...params,
});

const parseJson = (text: string): JsonValue | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const searchOne = async (guest: MentionGuest, query: string, directory: string | null, persistPath: string, callService: typeof proxyGuestServiceRequest | undefined, signal: AbortSignal | undefined) => {
  try {
    const answer = await askService(guest, persistPath, {
      path: MENTIONS_SEARCH_PATH,
      body: JSON.stringify({ query, directory }),
      timeoutMs: MENTIONS_SEARCH_TIMEOUT_MS,
      responseMax: SEARCH_ANSWER_MAX,
      signal,
    }, callService);
    const payload = answer.status === 200 ? parseJson(answer.body) : null;
    const items = isJsonObject(payload) ? payload.items : null;
    if (!Array.isArray(items)) return [];
    return items.slice(0, MENTIONS_ITEMS_MAX).flatMap((item) => {
      const parsed = mentionItemSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
};

export const searchGuestMentions = async ({ guests, query, directory, persistPath, callService, signal }: { guests: GuestRecord[]; query: string; directory: string | null; persistPath: string; callService?: typeof proxyGuestServiceRequest; signal?: AbortSignal }) => {
  const asked = guests.filter((guest): guest is MentionGuest & { mentions: NonNullable<GuestRecord['mentions']> } => !!(guest.mentions && guest.service && isMentionGuest(guest)));
  const answers = await Promise.all(asked.map((guest) => searchOne(guest, query, directory, persistPath, callService, signal)));
  return asked
    .map((guest, index) => ({ guestId: guest.id, label: guest.mentions.label, items: answers[index] ?? [] }))
    .filter((group) => group.items.length > 0);
};

export const resolveGuestMention = async ({ guest, id, persistPath, callService }: { guest: MentionGuest; id: string; persistPath: string; callService?: typeof proxyGuestServiceRequest }) => {
  const answer = await askService(guest, persistPath, {
    path: MENTIONS_RESOLVE_PATH,
    body: JSON.stringify({ id }),
    timeoutMs: MENTIONS_RESOLVE_TIMEOUT_MS,
    responseMax: RESOLVE_ANSWER_MAX,
  }, callService);
  const parsed = answer.status === 200 ? mentionsResolveResultSchema.safeParse(parseJson(answer.body)) : null;
  if (!parsed?.success) throw Object.assign(new Error('The service gave no text for this row.'), { code: 'MENTION_FAILED' });
  return parsed.data.text;
};
