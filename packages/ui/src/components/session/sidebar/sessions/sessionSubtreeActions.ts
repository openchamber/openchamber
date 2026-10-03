import type { ExternalToast } from 'sonner';
import type { Session } from '@/lib/opencode/model';
import { toast } from '@/components/ui';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { takeSessionActionFailure } from '@/sync/session-action-failures';
import { describeSessionActionError } from './sessionActionError';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore, type SessionUIState } from '@/sync/session-ui-store';
import { getDescendantIds } from '../list/sessionCollection';

type Translate = (key: I18nKey, params?: I18nParams) => string;

export type SessionSubtreeAction = 'archive' | 'delete';

export type SessionSubtreeStore = Pick<
  SessionUIState,
  'archiveSession' | 'archiveSessions' | 'deleteSession' | 'deleteSessions'
>;

export type SessionSubtreeOutcome = {
  succeededIds: string[];
  failedIds: string[];
};

/**
 * Every descendant an archive or delete should reach, resolved when the user
 * acts rather than while rows render.
 *
 * `knownDescendantIds` is what the surface already sees: the rendered tree on
 * desktop, the active list on mobile. Both stop at an archived child, so an
 * active subagent under an archived intermediate stayed behind (an edge #2580
 * pointed out). The global cache holds active and archived sessions together,
 * so walking it from the root reaches through archived intermediates. Archived
 * sessions are then dropped for archive, which must not retimestamp them, and
 * kept for delete, which removes the whole subtree.
 */
export const collectSessionSubtreeIds = (
  rootId: string,
  knownDescendantIds: readonly string[],
  includeArchived: boolean,
): string[] => {
  const global = useGlobalSessionsStore.getState();
  const childrenByParentId = new Map<string, Session[]>();
  for (const session of [...global.activeSessions, ...global.archivedSessions]) {
    const parentId = session.parentID;
    if (!parentId) continue;
    const siblings = childrenByParentId.get(parentId) ?? [];
    siblings.push(session);
    childrenByParentId.set(parentId, siblings);
  }
  const ids = new Set(knownDescendantIds);
  for (const id of getDescendantIds(childrenByParentId, rootId)) {
    if (!includeArchived && global.entityById.get(id)?.time?.archived) continue;
    ids.add(id);
  }
  ids.delete(rootId);
  return [...ids];
};

// The first recorded server answer for the failed ids, as a toast description.
const failureDescription = (ids: readonly string[], t: Translate): { description: string } | undefined => {
  const error = takeSessionActionFailure(ids);
  return error ? { description: describeSessionActionError(error, t) } : undefined;
};

/**
 * Undo an archive that just succeeded.
 *
 * Restores exactly the sessions that archive moved, on the runtime they were
 * archived on. When the archive closed the open session (`reopenId`) and the
 * user has not opened another one since, it opens again, so the screen returns
 * to where it was. Archive side effects that are not archive state, such as a
 * deleted btw fork, are not undone.
 */
export const undoArchive = async (
  archivedIds: readonly string[],
  reopenId: string | null,
  runtimeKey: string,
  t: Translate,
): Promise<void> => {
  const { restoredIds, failedIds } = await useSessionUIStore.getState()
    .unarchiveSessions([...archivedIds], { expectedRuntimeKey: runtimeKey, undo: true });
  if (failedIds.length > 0) {
    toast.error(t('sessions.sidebar.session.restore.error'), failureDescription(failedIds, t));
  }
  if (!reopenId || !restoredIds.includes(reopenId)) return;
  const ui = useSessionUIStore.getState();
  if (ui.currentSessionId !== null || getRuntimeKey() !== runtimeKey) return;
  const session = useGlobalSessionsStore.getState().entityById.get(reopenId);
  if (session) ui.setCurrentSession(reopenId, resolveGlobalSessionDirectory(session));
};

/** Toast options offering Undo for an archive that just succeeded. */
export const archiveUndoToastOptions = (
  archivedIds: readonly string[],
  reopenId: string | null,
  t: Translate,
): ExternalToast => {
  const runtimeKey = getRuntimeKey();
  return {
    action: {
      label: t('sessions.sidebar.session.archive.undo'),
      onClick: () => { void undoArchive(archivedIds, reopenId, runtimeKey, t); },
    },
  };
};

/**
 * Archive or hard-delete a session together with its descendants.
 *
 * The server does not cascade `time.archived`, so a parent archived on its own
 * leaves its subagents active as orphan roots. Desktop sidebar rows, Recent,
 * managed Chats, and the mobile sessions sheet resolve the subtree first and
 * run it through here, so the calls made and the outcome the user sees stay
 * the same: a lone session keeps the singular copy, a subtree reports counts,
 * and a partial failure says how many sessions were left behind.
 */
export const runSessionSubtreeAction = async (
  action: SessionSubtreeAction,
  session: Session,
  descendantIds: readonly string[],
  store: SessionSubtreeStore,
  t: Translate,
): Promise<SessionSubtreeOutcome> => {
  const hardDelete = action === 'delete';
  const reopenId = useSessionUIStore.getState().currentSessionId === session.id ? session.id : null;
  if (descendantIds.length === 0) {
    const success = hardDelete
      ? await store.deleteSession(session.id)
      : await store.archiveSession(session.id);
    if (success) {
      if (hardDelete) toast.success(t('sessions.sidebar.session.delete.success'));
      else toast.success(t('sessions.sidebar.session.archive.success'), archiveUndoToastOptions([session.id], reopenId, t));
      return { succeededIds: [session.id], failedIds: [] };
    }
    toast.error(hardDelete
      ? t('sessions.sidebar.session.delete.error')
      : t('sessions.sidebar.session.archive.error'), failureDescription([session.id], t));
    return { succeededIds: [], failedIds: [session.id] };
  }

  const ids = [session.id, ...descendantIds];
  if (hardDelete) {
    // Delete root + all descendants individually. If the server
    // cascade-deletes some children before we get to them, 404 is
    // treated as success by deleteSession and no rollback occurs.
    const { deletedIds, failedIds } = await store.deleteSessions(ids);
    if (failedIds.length === 0) {
      const totalDeleted = deletedIds.length;
      toast.success(totalDeleted === 1
        ? t('sessions.sidebar.bulkActions.deletedSingle', { count: totalDeleted })
        : t('sessions.sidebar.bulkActions.deletedPlural', { count: totalDeleted }));
    } else {
      toast.error(t('sessions.sidebar.session.delete.error'), failureDescription(failedIds, t));
    }
    return { succeededIds: deletedIds, failedIds };
  }

  const { archivedIds, failedIds } = await store.archiveSessions(ids);
  if (archivedIds.length > 0) {
    toast.success(archivedIds.length === 1
      ? t('sessions.sidebar.bulkActions.archivedSingle', { count: archivedIds.length })
      : t('sessions.sidebar.bulkActions.archivedPlural', { count: archivedIds.length }),
    archiveUndoToastOptions(archivedIds, reopenId, t));
  }
  if (failedIds.length > 0) {
    toast.error(failedIds.length === 1
      ? t('sessions.sidebar.bulkActions.failedArchiveSingle', { count: failedIds.length })
      : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length }), failureDescription(failedIds, t));
  }
  return { succeededIds: archivedIds, failedIds };
};
