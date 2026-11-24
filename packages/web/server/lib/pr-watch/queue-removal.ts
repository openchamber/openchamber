import { z } from 'zod';

const cursorSchema = z.object({ id: z.string().min(1), createdAt: z.iso.datetime({ offset: true }) });
export const latestQueueRemovalSchema = cursorSchema.extend({
  reason: z.string().nullish().catch(undefined),
}).nullish().catch(undefined);
export const queueRemovalStateSchema = z.object({
  cursor: cursorSchema.nullish(),
  since: z.number().finite().nonnegative().optional(),
}).optional().catch(undefined);

type Cursor = z.infer<typeof cursorSchema> | null | undefined;
type LatestRemoval = z.infer<typeof latestQueueRemovalSchema>;
type QueueRemovalState = z.infer<typeof queueRemovalStateSchema>;

const advanceCursor = (previous: Cursor, observed: LatestRemoval): Cursor => {
  if (observed === undefined) return previous;
  if (observed === null) return previous ?? null;
  if (previous && (observed.id === previous.id || Date.parse(observed.createdAt) < Date.parse(previous.createdAt))) return previous;
  return { id: observed.id, createdAt: observed.createdAt };
};

export const armQueueRemoval = (previous: QueueRemovalState, observed: LatestRemoval, armedAt: number): QueueRemovalState => {
  const cursor = advanceCursor(previous?.cursor, observed);
  return { cursor, since: cursor === undefined ? armedAt : undefined };
};

export const cleanQueueRemovalReason = (reason?: string | null) =>
  reason?.replace(/[<>\s\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 200).trimEnd() || undefined;

const GITHUB_TIMESTAMP_PRECISION_MS = 1000;

export const observeQueueRemoval = (previous: QueueRemovalState, observed: LatestRemoval, armedAt: number) => {
  const since = previous?.since ?? (previous?.cursor === undefined ? armedAt : undefined);
  if (observed === undefined) {
    const state = { cursor: previous?.cursor, since };
    return previous && state.since === previous.since ? null : { state, removed: false, degraded: false, reason: undefined };
  }
  const cursor = advanceCursor(previous?.cursor, observed);
  const state = { cursor, since: undefined };
  if (cursor === previous?.cursor && previous?.since === undefined) return null;
  const isNew = Boolean(cursor && cursor !== previous?.cursor);
  const at = cursor ? Date.parse(cursor.createdAt) : 0;
  const stampedBeforeStart = at + GITHUB_TIMESTAMP_PRECISION_MS <= armedAt;
  const knownTimeline = since === undefined;
  const removed = isNew && !stampedBeforeStart && (knownTimeline || at > since);
  const degraded = isNew && !stampedBeforeStart && !removed;
  return { state, removed, degraded, reason: removed ? cleanQueueRemovalReason(observed?.reason) : undefined };
};
