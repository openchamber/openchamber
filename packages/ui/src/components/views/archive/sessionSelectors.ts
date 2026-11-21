import type { Session } from '@/lib/opencode/model';
import { memoizeSessionListProjection } from '@/stores/sessionListProjection';
import type { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isRestorableOnItsOwn } from '@/sync/session-restore-rule';

type State = ReturnType<typeof useGlobalSessionsStore.getState>;

const restorable = () => memoizeSessionListProjection(
  (sessions: Session[], entities: ReadonlyMap<string, Session>) =>
    sessions.filter((session) => isRestorableOnItsOwn(session, entities)),
);
const archived = restorable();
const active = restorable();
const parentTitles = memoizeSessionListProjection(
  (sessions: Session[], entities: ReadonlyMap<string, Session>) => sessions.flatMap((session) => {
    const parent = session.parentID ? entities.get(session.parentID) : undefined;
    return parent ? [parent.id, parent.title] : [];
  }),
);

export const selectArchivedSessions = (state: State): Session[] => archived(state.archivedSessions, state.entityById);
export const selectActiveArchiveSessions = (state: State): Session[] => active(state.activeSessions, state.entityById);
export const selectArchiveParentTitles = (state: State): string[] => parentTitles(state.archivedSessions, state.entityById);
