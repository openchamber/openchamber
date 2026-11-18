import { z } from 'zod';

const workSchema = z.object({
  state: z.enum(['open', 'done']),
  openedAt: z.number().optional(),
  openedBy: z.enum(['auto', 'jev', 'user']).optional(),
  doneAt: z.number().optional(),
  suggestDoneAt: z.number().optional(),
});

const metadataSchema = z.object({ openchamber: z.object({ work: workSchema }) });
const pinnedSchema = z.object({ openchamber: z.object({ pinned: z.object({ at: z.number() }) }) });

export const isPinnedMetadata = (metadata) => pinnedSchema.safeParse(metadata).success;
const reviewOfferSchema = z.object({ openchamber: z.object({ reviewOffer: z.object({ at: z.number() }) }) });

export const readWork = (metadata) => metadataSchema.safeParse(metadata).data?.openchamber.work ?? null;

const patchOf = (work) => ({ openchamber: { work } });

export const openPatch = (metadata, { requestAt, now }) => {
  if (isPinnedMetadata(metadata)) return null;
  const work = readWork(metadata);
  if (work?.state === 'open') return null;
  if (work?.state === 'done' && Number.isFinite(requestAt) && (work.doneAt ?? 0) >= requestAt) return null;
  return patchOf({ state: 'open', openedAt: now, openedBy: 'auto', doneAt: null, suggestDoneAt: null });
};

export const userStatePatch = (metadata, { state, now }) => {
  if (readWork(metadata)?.state === state) return null;
  if (state === 'open' && isPinnedMetadata(metadata)) return null;
  return patchOf(state === 'open'
    ? { state: 'open', openedAt: now, openedBy: 'user', doneAt: null, suggestDoneAt: null }
    : { state: 'done', doneAt: now, suggestDoneAt: null });
};

export const suggestDonePatch = (metadata, { now }) => {
  if (readWork(metadata)?.state !== 'open') return null;
  const patch = patchOf({ suggestDoneAt: now });
  if (reviewOfferSchema.safeParse(metadata).success) patch.openchamber.reviewOffer = null;
  return patch;
};

export const offerReviewPatch = (_metadata, { now }) => ({ openchamber: { reviewOffer: { at: now } } });

export const clearSuggestionPatch = (metadata) => {
  const patch = {};
  if (readWork(metadata)?.suggestDoneAt !== undefined) patch.work = { suggestDoneAt: null };
  if (reviewOfferSchema.safeParse(metadata).success) patch.reviewOffer = null;
  return Object.keys(patch).length > 0 ? { openchamber: patch } : null;
};
