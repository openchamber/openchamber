import { create } from 'zustand';
import { z } from 'zod';

/**
 * Sessions whose agent waits on pull requests, as the OpenChamber server's
 * watches say (`packages/web/server/lib/pr-watch`). The server follows each
 * pull request and wakes the session; this is only what the UI shows while it
 * waits: the composer row and a row that reads as working. Kept free of the
 * transport (`pr-watch-sync.ts` reads and writes the server), so session
 * activity can read it the way it reads `workflow-activity.ts`.
 */
const watchSchema = z.object({
  sessionID: z.string().min(1),
  directory: z.string().min(1),
  url: z.string().min(1),
  number: z.number(),
  title: z.string(),
  status: z.enum(['unknown', 'pending', 'passed', 'failed', 'open', 'waking']),
  startedAt: z.number(),
});

export type PrWatch = z.infer<typeof watchSchema>;

export const prWatchSnapshotSchema = z.object({ revision: z.number(), watches: z.array(watchSchema) });

export const prWatchUpdatedEventSchema = z.object({
  type: z.literal('openchamber:pr-watch.updated'),
  properties: z.object({
    revision: z.number(),
    sessionID: z.string().min(1),
    watch: watchSchema.nullable(),
    // Absent from servers where a session waited on one pull request at most.
    watches: z.array(watchSchema).optional(),
  }),
});

export type PrWatchUpdatedEvent = z.infer<typeof prWatchUpdatedEventSchema>;

type PrWatchState = {
  /** Watches of the active runtime by session, in the order it started them; never an empty list. */
  bySession: ReadonlyMap<string, readonly PrWatch[]>;
};

const NONE: ReadonlyMap<string, readonly PrWatch[]> = new Map();

export const usePrWatchStore = create<PrWatchState>(() => ({ bySession: NONE }));

/** Revision last applied per session, and of the last full snapshot. */
const appliedRevisions = new Map<string, number>();
let snapshotRevision = -1;

const publish = (next: Map<string, readonly PrWatch[]>): void => {
  usePrWatchStore.setState({ bySession: next.size === 0 ? NONE : next });
};

/** One session's watches from the server, unless something newer was applied. */
export const applyPrWatches = (revision: number, sessionID: string, watches: readonly PrWatch[]): void => {
  if (snapshotRevision > revision || (appliedRevisions.get(sessionID) ?? -1) > revision) return;
  appliedRevisions.set(sessionID, revision);
  const current = usePrWatchStore.getState().bySession;
  if (watches.length === 0 && !current.has(sessionID)) return;
  const next = new Map(current);
  if (watches.length > 0) next.set(sessionID, watches);
  else next.delete(sessionID);
  publish(next);
};

/** The server's full list, replacing what is known except changes newer than it. */
export const applyPrWatchSnapshot = (snapshot: z.infer<typeof prWatchSnapshotSchema>): void => {
  if (snapshotRevision > snapshot.revision) return;
  snapshotRevision = snapshot.revision;
  const isNewer = (sessionID: string) => (appliedRevisions.get(sessionID) ?? -1) > snapshot.revision;
  const next = new Map<string, readonly PrWatch[]>();
  for (const [sessionID, watches] of usePrWatchStore.getState().bySession) if (isNewer(sessionID)) next.set(sessionID, watches);
  for (const watch of snapshot.watches) {
    if (isNewer(watch.sessionID)) continue;
    appliedRevisions.set(watch.sessionID, snapshot.revision);
    next.set(watch.sessionID, [...(next.get(watch.sessionID) ?? []), watch]);
  }
  publish(next);
};

/** What an optimistic stop took, and what the projection knew when it did. */
type TakenPrWatches = { sessionID: string; watches: readonly PrWatch[]; revision: number | undefined; snapshotRevision: number; generation: number };

// Bumped by a runtime switch, so a stop begun on one runtime never restores into another.
let generation = 0;

/** Removes the session's watch of `url`, or every one without it, for an optimistic stop; returns what it took. */
export const takePrWatches = (sessionID: string, url?: string): TakenPrWatches | undefined => {
  const current = usePrWatchStore.getState().bySession;
  const watches = current.get(sessionID) ?? [];
  const taken = watches.filter((watch) => url === undefined || watch.url === url);
  if (taken.length === 0) return undefined;
  const kept = watches.filter((watch) => !taken.includes(watch));
  const next = new Map(current);
  if (kept.length > 0) next.set(sessionID, kept);
  else next.delete(sessionID);
  publish(next);
  return { sessionID, watches: taken, revision: appliedRevisions.get(sessionID), snapshotRevision, generation };
};

/**
 * Puts back watches an optimistic stop removed when the request failed, unless
 * the server said anything newer about the session meanwhile: their removal
 * may have arrived even though the response to the stop did not.
 */
export const restorePrWatches = (taken: TakenPrWatches): void => {
  const { sessionID } = taken;
  if (taken.generation !== generation || taken.snapshotRevision !== snapshotRevision) return;
  if (appliedRevisions.get(sessionID) !== taken.revision) return;
  const current = usePrWatchStore.getState().bySession;
  const kept = current.get(sessionID) ?? [];
  const missing = taken.watches.filter((watch) => !kept.some((entry) => entry.url === watch.url));
  if (missing.length === 0) return;
  const restored = [...kept, ...missing].sort((left, right) => left.startedAt - right.startedAt);
  publish(new Map(current).set(sessionID, restored));
};

export const resetPrWatchesForRuntimeSwitch = (): void => {
  generation += 1;
  appliedRevisions.clear();
  snapshotRevision = -1;
  publish(new Map());
};
