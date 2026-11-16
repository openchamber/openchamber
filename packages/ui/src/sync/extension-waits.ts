import { create } from 'zustand';
import { z } from 'zod';

/**
 * Sessions whose agent waits on a timer or on something an extension follows,
 * as the OpenChamber server's waits say
 * (`packages/web/server/lib/extension-waits`). The server checks the clock or
 * the extension and wakes the session; this is only what
 * the UI shows meanwhile: the composer row and a session that reads as
 * working. Kept free of the transport (`extension-waits-sync.ts`), the way
 * `pr-watch.ts` is.
 */
const waitSchema = z.object({
  waitId: z.string().min(1),
  sessionID: z.string().min(1),
  directory: z.string().min(1).nullable(),
  source: z.string().min(1),
  extension: z.string().min(1),
  title: z.string().min(1),
  label: z.string().min(1).nullable(),
  startedAt: z.number(),
  status: z.enum(['waiting', 'waking']),
});

export type ExtensionWait = z.infer<typeof waitSchema>;

export const extensionWaitsSnapshotSchema = z.object({ revision: z.number(), waits: z.array(waitSchema) });

export const extensionWaitsUpdatedEventSchema = z.object({
  type: z.literal('openchamber:extension-waits.updated'),
  properties: z.object({ revision: z.number(), sessionID: z.string().min(1), waits: z.array(waitSchema) }),
});

export type ExtensionWaitsUpdatedEvent = z.infer<typeof extensionWaitsUpdatedEventSchema>;

type ExtensionWaitsState = {
  /** Waits of the active runtime by session, oldest first; a session without one has no entry. */
  bySession: ReadonlyMap<string, readonly ExtensionWait[]>;
};

const NONE: ReadonlyMap<string, readonly ExtensionWait[]> = new Map();

export const useExtensionWaitsStore = create<ExtensionWaitsState>(() => ({ bySession: NONE }));

/** Revision last applied per session, and of the last full snapshot. */
const appliedRevisions = new Map<string, number>();
let snapshotRevision = -1;

const publish = (next: Map<string, readonly ExtensionWait[]>): void => {
  useExtensionWaitsStore.setState({ bySession: next.size === 0 ? NONE : next });
};

/** One session's waits from the server, unless something newer was applied. */
export const applyExtensionWaits = (revision: number, sessionID: string, waits: readonly ExtensionWait[]): void => {
  if (snapshotRevision > revision || (appliedRevisions.get(sessionID) ?? -1) > revision) return;
  appliedRevisions.set(sessionID, revision);
  const current = useExtensionWaitsStore.getState().bySession;
  if (waits.length === 0 && !current.has(sessionID)) return;
  const next = new Map(current);
  if (waits.length > 0) next.set(sessionID, waits);
  else next.delete(sessionID);
  publish(next);
};

/** The server's full list, replacing what is known except changes newer than it. */
export const applyExtensionWaitsSnapshot = (snapshot: z.infer<typeof extensionWaitsSnapshotSchema>): void => {
  if (snapshotRevision > snapshot.revision) return;
  snapshotRevision = snapshot.revision;
  const isNewer = (sessionID: string) => (appliedRevisions.get(sessionID) ?? -1) > snapshot.revision;
  const next = new Map<string, ExtensionWait[]>();
  for (const [sessionID, waits] of useExtensionWaitsStore.getState().bySession) if (isNewer(sessionID)) next.set(sessionID, [...waits]);
  for (const wait of snapshot.waits) {
    if (isNewer(wait.sessionID)) continue;
    appliedRevisions.set(wait.sessionID, snapshot.revision);
    next.set(wait.sessionID, [...(next.get(wait.sessionID) ?? []), wait]);
  }
  publish(next);
};

/** What an optimistic stop took, and what the projection knew when it did. */
type TakenExtensionWaits = { sessionID: string; waits: readonly ExtensionWait[]; revision: number | undefined; snapshotRevision: number; generation: number };

// Bumped by a runtime switch, so a stop begun on one runtime never restores into another.
let generation = 0;

/** Removes the session's waits at once, for an optimistic stop; returns what was there. */
export const takeExtensionWaits = (sessionID: string): TakenExtensionWaits | undefined => {
  const current = useExtensionWaitsStore.getState().bySession;
  const waits = current.get(sessionID);
  if (!waits) return undefined;
  const next = new Map(current);
  next.delete(sessionID);
  publish(next);
  return { sessionID, waits, revision: appliedRevisions.get(sessionID), snapshotRevision, generation };
};

/**
 * Puts back waits an optimistic stop removed when the request failed, unless
 * the server said anything newer about the session meanwhile.
 */
export const restoreExtensionWaits = (taken: TakenExtensionWaits): void => {
  if (taken.generation !== generation || taken.snapshotRevision !== snapshotRevision) return;
  if (appliedRevisions.get(taken.sessionID) !== taken.revision) return;
  const current = useExtensionWaitsStore.getState().bySession;
  if (current.has(taken.sessionID)) return;
  publish(new Map(current).set(taken.sessionID, taken.waits));
};

export const resetExtensionWaitsForRuntimeSwitch = (): void => {
  generation += 1;
  appliedRevisions.clear();
  snapshotRevision = -1;
  publish(new Map());
};
