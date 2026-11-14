/**
 * `metadata.openchamber.work`: whether a session is in work and what Jev
 * currently suggests about it; `metadata.openchamber.reviewOffer`: Jev's offer
 * to look over the last turn's changes, which does not depend on work. Every
 * function returns a JSON merge patch for the session metadata store, or null
 * when nothing changes, so the store can decide against the record as it is
 * at write time.
 *
 * The rule the patches keep: sending a message opens, only the user closes.
 * A message reopens a session the user closed, but only one sent after the
 * user closed it.
 */
import { z } from 'zod';

const workSchema = z.object({
  state: z.enum(['open', 'done']),
  openedAt: z.number().optional(),
  // `jev` on records from before every sent message opened a session.
  openedBy: z.enum(['auto', 'jev', 'user']).optional(),
  doneAt: z.number().optional(),
  suggestDoneAt: z.number().optional(),
});

const metadataSchema = z.object({ openchamber: z.object({ work: workSchema }) });
// The pin the UI writes (`packages/ui/src/lib/sessionPins.ts`): a pinned session is never in work.
const pinnedSchema = z.object({ openchamber: z.object({ pinned: z.object({ at: z.number() }) }) });

/** Whether the session is pinned, in Pinned or in one of the user's pin lists. */
export const isPinnedMetadata = (metadata) => pinnedSchema.safeParse(metadata).success;
const reviewOfferSchema = z.object({ openchamber: z.object({ reviewOffer: z.object({ at: z.number() }) }) });

/** The session's work record, or null when it has none (or a malformed one). */
export const readWork = (metadata) => metadataSchema.safeParse(metadata).data?.openchamber.work ?? null;

const patchOf = (work) => ({ openchamber: { work } });

/** The user sent a message at `requestAt`. A pinned session stays out of work. */
export const openPatch = (metadata, { requestAt, now }) => {
  if (isPinnedMetadata(metadata)) return null;
  const work = readWork(metadata);
  if (work?.state === 'open') return null;
  // Closed after this message was sent: the user's decision stands.
  if (work?.state === 'done' && Number.isFinite(requestAt) && (work.doneAt ?? 0) >= requestAt) return null;
  return patchOf({ state: 'open', openedAt: now, openedBy: 'auto', doneAt: null, suggestDoneAt: null });
};

/**
 * The user put the session in work (`open`, Track) or marked it done, in the
 * app or through an agent on their word. Done keeps when and by whom the work
 * was opened; both drop Jev's hint. The same record the UI writes
 * (`withSessionWorkState` in packages/ui).
 */
export const userStatePatch = (metadata, { state, now }) => {
  if (readWork(metadata)?.state === state) return null;
  // A pinned session is never in work; done still closes one an older build left open.
  if (state === 'open' && isPinnedMetadata(metadata)) return null;
  return patchOf(state === 'open'
    ? { state: 'open', openedAt: now, openedBy: 'user', doneAt: null, suggestDoneAt: null }
    : { state: 'done', doneAt: now, suggestDoneAt: null });
};

/**
 * The turn that ended looks like the end of the work, and the user stayed
 * quiet since. It replaces a review offer from the same turn.
 */
export const suggestDonePatch = (metadata, { now }) => {
  if (readWork(metadata)?.state !== 'open') return null;
  const patch = patchOf({ suggestDoneAt: now });
  if (reviewOfferSchema.safeParse(metadata).success) patch.openchamber.reviewOffer = null;
  return patch;
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
