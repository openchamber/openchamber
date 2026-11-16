import type { ExternalToast } from 'sonner';
import type { Session } from '@/lib/opencode/model';
import { toast } from '@/components/ui';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { takeSessionActionFailure } from '@/sync/session-action-failures';
import { describeSessionActionError } from './sessionActionError';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { readGlobalSessionLineage } from '@/stores/sessionLineage';
import { useSessionUIStore, type SessionUIState } from '@/sync/session-ui-store';
import { buildActiveSessionNode } from '../list/sessionCollection';
import type { SessionNode } from '../types';

type Translate = (key: I18nKey, params?: I18nParams) => string;

export type SessionSubtreeAction = 'archive' | 'delete';

export type SessionSubtreeStore = Pick<
  SessionUIState,
  'archiveSession' | 'archiveSessions' | 'deleteSession' | 'deleteSessions'
>;

type SessionSubtreeOutcome = {
  succeededIds: string[];
  failedIds: string[];
};

export const collectSessionSubtreeIds = (
  rootId: string,
  knownDescendantIds: readonly string[],
  includeArchived: boolean,
): string[] => {
  const ids = new Set(knownDescendantIds);
  const descendants = readGlobalSessionLineage().descendantsOf(rootId, includeArchived ? 'all' : 'activeThroughArchived');
  for (const descendant of descendants) ids.add(descendant.id);
  ids.delete(rootId);
  return [...ids];
};

export const collectParentIdDescendantIds = (root: SessionNode): string[] => {
  const ids: string[] = [];
  const visit = (node: SessionNode): void => {
    for (const child of node.children) {
      if (child.session.parentID !== node.session.id) continue;
      ids.push(child.session.id);
      visit(child);
    }
  };
  visit(root);
  return ids;
};

export const buildActiveSessionTreeFromCache = (root: Session): SessionNode => {
  const childrenByParentId = new Map<string, Session[]>();
  for (const session of readGlobalSessionLineage().descendantsOf(root.id, 'active')) {
    const parentId = session.parentID;
    if (!parentId) continue;
    const siblings = childrenByParentId.get(parentId) ?? [];
    siblings.push(session);
    childrenByParentId.set(parentId, siblings);
  }
  return buildActiveSessionNode(childrenByParentId, root);
};

export const collectSessionMoveDescendants = (root: Session, knownDescendants: readonly Session[]): Session[] => {
  const descendants = new Map(knownDescendants.map((session) => [session.id, session]));
  for (const descendant of readGlobalSessionLineage().descendantsOf(root.id, 'active')) {
    if (!descendants.has(descendant.id)) descendants.set(descendant.id, descendant);
  }
  descendants.delete(root.id);
  return [...descendants.values()];
};

const failureDescription = (ids: readonly string[], t: Translate): { description: string } | undefined => {
  const error = takeSessionActionFailure(ids);
  return error ? { description: describeSessionActionError(error, t) } : undefined;
};

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
