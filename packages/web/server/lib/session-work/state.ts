import { z } from 'zod';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';

const workSchema = z.object({
  state: z.enum(['open', 'done']),
  openedAt: z.number().optional(),
  openedBy: z.enum(['auto', 'jev', 'user']).optional(),
  doneAt: z.number().optional(),
  suggestDoneAt: z.number().optional(),
});

export type Work = z.infer<typeof workSchema>;

export interface WorkPatch {
  state?: Work['state'];
  openedAt?: number;
  openedBy?: NonNullable<Work['openedBy']>;
  doneAt?: number | null;
  suggestDoneAt?: number | null;
}

export type WorkMetadataPatch = {
  openchamber: {
    work?: WorkPatch;
    reviewOffer?: { at: number } | null;
  };
};

interface PatchTime {
  now: number;
}

const metadataSchema = z.object({ openchamber: z.object({ work: workSchema }) });
const pinnedSchema = z.object({ openchamber: z.object({ pinned: z.object({ at: z.number() }) }) });

export const isPinnedMetadata = (metadata: SessionMetadata | null | undefined) => pinnedSchema.safeParse(metadata).success;
const reviewOfferSchema = z.object({ openchamber: z.object({ reviewOffer: z.object({ at: z.number() }) }) });

export const readWork = (metadata: SessionMetadata | null | undefined) => metadataSchema.safeParse(metadata).data?.openchamber.work ?? null;

const patchOf = (work: WorkPatch): WorkMetadataPatch => ({ openchamber: { work } });

export const openPatch = (metadata: SessionMetadata | null | undefined, { requestAt, now }: PatchTime & { requestAt: number }) => {
  if (isPinnedMetadata(metadata)) return null;
  const work = readWork(metadata);
  if (work?.state === 'open') return null;
  if (work?.state === 'done' && Number.isFinite(requestAt) && (work.doneAt ?? 0) >= requestAt) return null;
  return patchOf({ state: 'open', openedAt: now, openedBy: 'auto', doneAt: null, suggestDoneAt: null });
};

export const userStatePatch = (metadata: SessionMetadata | null | undefined, { state, now }: PatchTime & { state: Work['state'] }) => {
  if (readWork(metadata)?.state === state) return null;
  if (state === 'open' && isPinnedMetadata(metadata)) return null;
  return patchOf(state === 'open'
    ? { state: 'open', openedAt: now, openedBy: 'user', doneAt: null, suggestDoneAt: null }
    : { state: 'done', doneAt: now, suggestDoneAt: null });
};

export const suggestDonePatch = (metadata: SessionMetadata | null | undefined, { now }: PatchTime) => {
  if (readWork(metadata)?.state !== 'open') return null;
  const patch = patchOf({ suggestDoneAt: now });
  if (reviewOfferSchema.safeParse(metadata).success) patch.openchamber.reviewOffer = null;
  return patch;
};

export const offerReviewPatch = (_metadata: SessionMetadata | null | undefined, { now }: PatchTime): WorkMetadataPatch => ({ openchamber: { reviewOffer: { at: now } } });

export const clearSuggestionPatch = (metadata: SessionMetadata | null | undefined): WorkMetadataPatch | null => {
  const patch: WorkMetadataPatch['openchamber'] = {};
  if (readWork(metadata)?.suggestDoneAt !== undefined) patch.work = { suggestDoneAt: null };
  if (reviewOfferSchema.safeParse(metadata).success) patch.reviewOffer = null;
  return Object.keys(patch).length > 0 ? { openchamber: patch } : null;
};
