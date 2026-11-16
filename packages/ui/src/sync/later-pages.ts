import { create } from 'zustand';
import { z } from 'zod';

/**
 * Pages an agent showed with answerLater, as the OpenChamber server keeps them
 * (`packages/web/server/lib/openchamber-control/later-pages.js`): open until
 * the user answers, then the answer they took. The call itself ended when the
 * page appeared, so this is the only place that says whether the page still
 * takes an answer. Kept free of the transport (`later-pages-sync.ts`), the way
 * `extension-waits.ts` is.
 */
const laterPageSchema = z.object({
  sessionID: z.string().min(1),
  callID: z.string().min(1),
  status: z.enum(['open', 'answered', 'declined', 'ui-not-drawn']),
  summary: z.string().optional(),
  data: z.json().optional().catch(undefined),
  /** Saved, but OpenCode has not taken the message yet; the server keeps trying. */
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
  /** Pages by session; a session without one has no entry. */
  bySession: ReadonlyMap<string, readonly LaterPage[]>;
};

const NONE: ReadonlyMap<string, readonly LaterPage[]> = new Map();

const useLaterPagesStore = create<LaterPagesState>(() => ({ bySession: NONE }));

/** Revision last applied per session, and of the last full snapshot. */
const appliedRevisions = new Map<string, number>();
let snapshotRevision = -1;

const publish = (next: Map<string, readonly LaterPage[]>): void => {
  useLaterPagesStore.setState({ bySession: next.size === 0 ? NONE : next });
};

/** One session's pages from the server, unless something newer was applied. */
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

/** The server's full list, replacing what is known except changes newer than it. */
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

/** This call's page as the server keeps it; undefined when it keeps none. */
export const useLaterPage = (sessionID: string, callID: string): LaterPage | undefined => (
  useLaterPagesStore((state) => (sessionID ? state.bySession.get(sessionID)?.find((page) => page.callID === callID) : undefined))
);

export const resetLaterPagesForRuntimeSwitch = (): void => {
  appliedRevisions.clear();
  snapshotRevision = -1;
  publish(new Map());
};
