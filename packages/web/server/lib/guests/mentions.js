import {
  MENTIONS_IDLE_MS,
  MENTIONS_RESOLVE_PATH,
  MENTIONS_RESOLVE_TIMEOUT_MS,
  MENTIONS_SEARCH_PATH,
  MENTIONS_SEARCH_TIMEOUT_MS,
  MENTION_TEXT_MAX,
  isGuestApproved,
  requestedGuestCapabilities,
} from '@openchamber/sdk';
import { mentionsResolveResultSchema, mentionsSearchResultSchema } from '@openchamber/sdk/schemas';

import { proxyGuestServiceRequest } from './service.js';

/**
 * The composer's `@` menu asks every active extension that declared
 * `contributes.mentions`. A slow or failing service adds no rows and never
 * holds the menu up; a row picked and then unreadable at send time is a
 * failure the composer shows, since the message would go out without what the
 * user chose.
 */

// A character is at most six bytes as an escaped JSON string; the envelope adds little.
const RESOLVE_ANSWER_MAX = MENTION_TEXT_MAX * 6 + 1_024;
const SEARCH_ANSWER_MAX = 256_000;

export const isMentionGuest = (guest) => guest.enabled !== false
  && guest.capabilityGrants?.includes('service') === true
  && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants });

const callService = (guest, persistPath, params) => proxyGuestServiceRequest({
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

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const searchOne = async (guest, query, directory, persistPath) => {
  try {
    const answer = await callService(guest, persistPath, {
      path: MENTIONS_SEARCH_PATH,
      body: JSON.stringify({ query, directory }),
      timeoutMs: MENTIONS_SEARCH_TIMEOUT_MS,
      responseMax: SEARCH_ANSWER_MAX,
    });
    const parsed = answer.status === 200 ? mentionsSearchResultSchema.safeParse(parseJson(answer.body)) : null;
    return parsed?.success ? parsed.data.items : [];
  } catch {
    return [];
  }
};

/**
 * @param {{ guests: object[], query: string, directory: string | null, persistPath: string }} params
 * @returns {Promise<Array<{ guestId: string, label: string, items: Array<{ id: string, title: string, subtitle?: string }> }>>}
 */
export const searchGuestMentions = async ({ guests, query, directory, persistPath }) => {
  const asked = guests.filter((guest) => guest.mentions && guest.service && isMentionGuest(guest));
  const answers = await Promise.all(asked.map((guest) => searchOne(guest, query, directory, persistPath)));
  return asked
    .map((guest, index) => ({ guestId: guest.id, label: guest.mentions.label, items: answers[index] }))
    .filter((group) => group.items.length > 0);
};

/**
 * The context of a picked row. Throws when the service cannot give it.
 * @param {{ guest: object, id: string, persistPath: string }} params
 * @returns {Promise<string>}
 */
export const resolveGuestMention = async ({ guest, id, persistPath }) => {
  const answer = await callService(guest, persistPath, {
    path: MENTIONS_RESOLVE_PATH,
    body: JSON.stringify({ id }),
    timeoutMs: MENTIONS_RESOLVE_TIMEOUT_MS,
    responseMax: RESOLVE_ANSWER_MAX,
  });
  const parsed = answer.status === 200 ? mentionsResolveResultSchema.safeParse(parseJson(answer.body)) : null;
  if (!parsed?.success) throw Object.assign(new Error('The service gave no text for this row.'), { code: 'MENTION_FAILED' });
  return parsed.data.text;
};
