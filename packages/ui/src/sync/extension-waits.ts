import { create } from 'zustand';
import { z } from 'zod';

export const waitArgsSchema = z.object({
  minutes: z.number().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
});

const waitSchema = z.object({
  waitId: z.string().min(1),
  sessionID: z.string().min(1),
  directory: z.string().min(1).nullable(),
  source: z.string().min(1),
  extension: z.string().min(1),
  title: z.string().min(1),
  label: z.string().min(1).nullable(),
  args: waitArgsSchema.optional().catch(undefined),
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
  bySession: ReadonlyMap<string, readonly ExtensionWait[]>;
};

const NONE: ReadonlyMap<string, readonly ExtensionWait[]> = new Map();

export const useExtensionWaitsStore = create<ExtensionWaitsState>(() => ({ bySession: NONE }));

const appliedRevisions = new Map<string, number>();
let snapshotRevision = -1;

const publish = (next: Map<string, readonly ExtensionWait[]>): void => {
  useExtensionWaitsStore.setState({ bySession: next.size === 0 ? NONE : next });
};

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

type TakenExtensionWaits = { sessionID: string; waits: readonly ExtensionWait[]; revision: number | undefined; snapshotRevision: number; generation: number };

let generation = 0;

export const takeExtensionWaits = (sessionID: string): TakenExtensionWaits | undefined => {
  const current = useExtensionWaitsStore.getState().bySession;
  const waits = current.get(sessionID);
  if (!waits) return undefined;
  const next = new Map(current);
  next.delete(sessionID);
  publish(next);
  return { sessionID, waits, revision: appliedRevisions.get(sessionID), snapshotRevision, generation };
};

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
