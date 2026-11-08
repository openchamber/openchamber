import { create } from 'zustand';
import { z } from 'zod';

/**
 * Sessions whose agent waits on a pull request, as the OpenChamber server's
 * watches say (`packages/web/server/lib/pr-watch`). The server follows the
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
  properties: z.object({ revision: z.number(), sessionID: z.string().min(1), watch: watchSchema.nullable() }),
});

export type PrWatchUpdatedEvent = z.infer<typeof prWatchUpdatedEventSchema>;

type PrWatchState = {
  /** Watches of the active runtime by session. */
  bySession: ReadonlyMap<string, PrWatch>;
};

const NONE: ReadonlyMap<string, PrWatch> = new Map();

export const usePrWatchStore = create<PrWatchState>(() => ({ bySession: NONE }));

/** Revision last applied per session, and of the last full snapshot. */
const appliedRevisions = new Map<string, number>();
let snapshotRevision = -1;

const publish = (next: Map<string, PrWatch>): void => {
  usePrWatchStore.setState({ bySession: next.size === 0 ? NONE : next });
};

/** One session's watch from the server, unless something newer was applied. */
export const applyPrWatch = (revision: number, sessionID: string, watch: PrWatch | null): void => {
  if (snapshotRevision > revision || (appliedRevisions.get(sessionID) ?? -1) > revision) return;
  appliedRevisions.set(sessionID, revision);
  const current = usePrWatchStore.getState().bySession;
  if (!watch && !current.has(sessionID)) return;
  const next = new Map(current);
  if (watch) next.set(sessionID, watch);
  else next.delete(sessionID);
  publish(next);
};

/** The server's full list, replacing what is known except changes newer than it. */
export const applyPrWatchSnapshot = (snapshot: z.infer<typeof prWatchSnapshotSchema>): void => {
  if (snapshotRevision > snapshot.revision) return;
  snapshotRevision = snapshot.revision;
  const isNewer = (sessionID: string) => (appliedRevisions.get(sessionID) ?? -1) > snapshot.revision;
  const next = new Map<string, PrWatch>();
  for (const [sessionID, watch] of usePrWatchStore.getState().bySession) if (isNewer(sessionID)) next.set(sessionID, watch);
  for (const watch of snapshot.watches) {
    if (isNewer(watch.sessionID)) continue;
    appliedRevisions.set(watch.sessionID, snapshot.revision);
    next.set(watch.sessionID, watch);
  }
  publish(next);
};

/** What an optimistic stop took, and what the projection knew when it did. */
type TakenPrWatch = { watch: PrWatch; revision: number | undefined; snapshotRevision: number; generation: number };

// Bumped by a runtime switch, so a stop begun on one runtime never restores into another.
let generation = 0;

/** Removes the session's watch at once, for an optimistic stop; returns what was there. */
export const takePrWatch = (sessionID: string): TakenPrWatch | undefined => {
  const current = usePrWatchStore.getState().bySession;
  const watch = current.get(sessionID);
  if (!watch) return undefined;
  const next = new Map(current);
  next.delete(sessionID);
  publish(next);
  return { watch, revision: appliedRevisions.get(sessionID), snapshotRevision, generation };
};

/**
 * Puts back a watch an optimistic stop removed when the request failed, unless
 * the server said anything newer about it meanwhile: its removal may have
 * arrived even though the response to the stop did not.
 */
export const restorePrWatch = (taken: TakenPrWatch): void => {
  const { sessionID } = taken.watch;
  if (taken.generation !== generation || taken.snapshotRevision !== snapshotRevision) return;
  if (appliedRevisions.get(sessionID) !== taken.revision) return;
  const current = usePrWatchStore.getState().bySession;
  if (current.has(sessionID)) return;
  publish(new Map(current).set(sessionID, taken.watch));
};

export const resetPrWatchesForRuntimeSwitch = (): void => {
  generation += 1;
  appliedRevisions.clear();
  snapshotRevision = -1;
  publish(new Map());
};
