import { create } from 'zustand';
import { z } from 'zod';

const laterPageSchema = z.object({
  sessionID: z.string().min(1),
  callID: z.string().min(1),
  status: z.enum(['open', 'answered', 'declined', 'ui-not-drawn']),
  summary: z.string().optional(),
  data: z.json().optional().catch(undefined),
  undelivered: z.literal(true).optional().catch(undefined),
});

export type LaterPage = z.infer<typeof laterPageSchema>;

export const laterPagesSnapshotSchema = z.object({ revision: z.number(), pages: z.array(laterPageSchema) });

export const laterPagesUpdatedEventSchema = z.object({
  type: z.literal('openchamber:render-later.updated'),
  properties: z.object({ revision: z.number(), sessionID: z.string().min(1), pages: z.array(laterPageSchema) }),
});

export type LaterPagesUpdatedEvent = z.infer<typeof laterPagesUpdatedEventSchema>;

type LaterPagesState = {
  bySession: ReadonlyMap<string, readonly LaterPage[]>;
};

const NONE: ReadonlyMap<string, readonly LaterPage[]> = new Map();

const useLaterPagesStore = create<LaterPagesState>(() => ({ bySession: NONE }));

const appliedRevisions = new Map<string, number>();
let snapshotRevision = -1;

const publish = (next: Map<string, readonly LaterPage[]>): void => {
  useLaterPagesStore.setState({ bySession: next.size === 0 ? NONE : next });
};

export const applyLaterPages = (revision: number, sessionID: string, pages: readonly LaterPage[]): void => {
  if (snapshotRevision > revision || (appliedRevisions.get(sessionID) ?? -1) > revision) return;
  appliedRevisions.set(sessionID, revision);
  const current = useLaterPagesStore.getState().bySession;
  if (pages.length === 0 && !current.has(sessionID)) return;
  const next = new Map(current);
  if (pages.length > 0) next.set(sessionID, pages);
  else next.delete(sessionID);
  publish(next);
};

export const applyLaterPagesSnapshot = (snapshot: z.infer<typeof laterPagesSnapshotSchema>): void => {
  if (snapshotRevision > snapshot.revision) return;
  snapshotRevision = snapshot.revision;
  const isNewer = (sessionID: string) => (appliedRevisions.get(sessionID) ?? -1) > snapshot.revision;
  const next = new Map<string, LaterPage[]>();
  for (const [sessionID, pages] of useLaterPagesStore.getState().bySession) if (isNewer(sessionID)) next.set(sessionID, [...pages]);
  for (const page of snapshot.pages) {
    if (isNewer(page.sessionID)) continue;
    appliedRevisions.set(page.sessionID, snapshot.revision);
    next.set(page.sessionID, [...(next.get(page.sessionID) ?? []), page]);
  }
  publish(next);
};

export const useLaterPage = (sessionID: string, callID: string): LaterPage | undefined => (
  useLaterPagesStore((state) => (sessionID ? state.bySession.get(sessionID)?.find((page) => page.callID === callID) : undefined))
);

export const resetLaterPagesForRuntimeSwitch = (): void => {
  appliedRevisions.clear();
  snapshotRevision = -1;
  publish(new Map());
};
