/**
 * `metadata.openchamber.work`: whether a session is in work and what Jev
 * currently suggests about it; `metadata.openchamber.reviewOffer`: Jev's offer
 * to look over the last turn's changes, which does not depend on work. Every function returns a JSON merge patch for
 * the session metadata store, or null when nothing changes, so the store can
 * decide against the record as it is at write time.
 *
 * The rule the patches keep: Jev only ever opens, the user alone closes. Jev
 * may reopen a session the user closed, but only for a request sent after the
 * user closed it.
 */
import { z } from 'zod';

const workSchema = z.object({
  state: z.enum(['open', 'done']),
  openedAt: z.number().optional(),
  openedBy: z.enum(['jev', 'user']).optional(),
  doneAt: z.number().optional(),
  suggestDoneAt: z.number().optional(),
});

const metadataSchema = z.object({ openchamber: z.object({ work: workSchema }) });
const reviewOfferSchema = z.object({ openchamber: z.object({ reviewOffer: z.object({ at: z.number() }) }) });

/** The session's work record, or null when it has none (or a malformed one). */
export const readWork = (metadata) => metadataSchema.safeParse(metadata).data?.openchamber.work ?? null;

const patchOf = (work) => ({ openchamber: { work } });

/** Jev saw a request that starts work, sent at `requestAt`. */
export const openByJevPatch = (metadata, { requestAt, now }) => {
  const work = readWork(metadata);
  if (work?.state === 'open') return null;
  // Closed after this request was sent: the user's decision stands.
  if (work?.state === 'done' && Number.isFinite(requestAt) && (work.doneAt ?? 0) >= requestAt) return null;
  return patchOf({ state: 'open', openedAt: now, openedBy: 'jev', doneAt: null, suggestDoneAt: null });
};

/** The turn that just ended looks like the end of the work. */
export const suggestDonePatch = (metadata, { now }) => {
  if (readWork(metadata)?.state !== 'open') return null;
  return patchOf({ suggestDoneAt: now });
};

/** The turn that just ended handed over changes worth a look; any session. */
export const offerReviewPatch = (_metadata, { now }) => ({ openchamber: { reviewOffer: { at: now } } });

/** A new turn started: whatever Jev concluded about the last one no longer holds. */
export const clearSuggestionPatch = (metadata) => {
  const patch = {};
  if (readWork(metadata)?.suggestDoneAt !== undefined) patch.work = { suggestDoneAt: null };
  if (reviewOfferSchema.safeParse(metadata).success) patch.reviewOffer = null;
  return Object.keys(patch).length > 0 ? { openchamber: patch } : null;
};
