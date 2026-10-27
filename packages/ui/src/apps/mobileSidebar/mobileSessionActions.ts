import { toast } from '@/components/ui';
import { getDescendantIds } from '@/components/session/sidebar/list/sessionCollection';
import { collectSessionSubtreeIds, runSessionSubtreeAction, type SessionSubtreeAction } from '@/components/session/sidebar/sessions/sessionSubtreeActions';
import { toastSessionWorkFailure } from '@/components/session/sidebar/sessions/sessionWorkFailure';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { SessionDirectoryMissingError, setSessionWorkState } from '@/sync/session-actions';
import { toggleSessionPin } from '@/sync/session-pins';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSessionDirectory } from '../mobileSessionFields';

type Translate = (key: I18nKey, params?: I18nParams) => string;

/** The active sessions by parent, read when an action runs rather than on every render. */
const childrenOfActiveSessions = (): Map<string, Session[]> => {
  const children = new Map<string, Session[]>();
  for (const session of useGlobalSessionsStore.getState().activeSessions) {
    if (!session.parentID) continue;
    children.set(session.parentID, [...(children.get(session.parentID) ?? []), session]);
  }
  return children;
};

/** Opens a session from the list: its project becomes the active one and the drawer closes. */
export const selectMobileSession = (session: Session, projectId: string | null, close: () => void): void => {
  // Selecting a session always leaves a full-page surface, as on the desktop.
  useUIStore.getState().closeMainSurfaces();
  if (projectId) useProjectsStore.getState().setActiveProjectIdOnly(projectId);
  void useSessionUIStore.getState().setCurrentSession(session.id, getSessionDirectory(session) || null);
  close();
};

/**
 * Archive or delete a session with its subagents. Lineage is resolved over
 * every active session rather than the rows on screen: a subagent can sit in
 * another worktree and still belongs to its parent.
 */
export const runMobileSubtreeAction = (action: SessionSubtreeAction, session: Session, t: Translate): ReturnType<typeof runSessionSubtreeAction> => {
  const store = useSessionUIStore.getState();
  return runSessionSubtreeAction(
    action,
    session,
    collectSessionSubtreeIds(session.id, getDescendantIds(childrenOfActiveSessions(), session.id), action === 'delete'),
    { archiveSession: store.archiveSession, archiveSessions: store.archiveSessions, deleteSession: store.deleteSession, deleteSessions: store.deleteSessions },
    t,
  );
};

/**
 * Track a root session's work, or with sessions of it in work, mark all of
 * them done, as the desktop row does.
 */
export const toggleMobileSessionWork = async (session: Session, sessionsInWork: readonly Session[], t: Translate): Promise<void> => {
  try {
    if (sessionsInWork.length === 0) {
      await setSessionWorkState(session.id, getSessionDirectory(session) || null, 'open');
      return;
    }
    for (const entry of sessionsInWork) {
      await setSessionWorkState(entry.id, getSessionDirectory(entry) || getSessionDirectory(session) || null, 'done');
    }
  } catch (error) {
    toastSessionWorkFailure(error instanceof SessionDirectoryMissingError, () => { void runMobileSubtreeAction('archive', session, t); }, t);
  }
};

export const toggleMobileSessionPin = (session: Session, pinned: boolean, t: Translate): void => {
  const directory = getSessionDirectory(session);
  if (!directory) return;
  const failedKey = pinned ? 'sessions.sidebar.session.pin.unpinFailed' : 'sessions.sidebar.session.pin.pinFailed';
  toggleSessionPin({ directory, sessionId: session.id }).catch(() => toast.error(t(failedKey)));
};

export const renameMobileSession = async (sessionId: string, title: string, t: Translate): Promise<void> => {
  try {
    await useSessionUIStore.getState().updateSessionTitle(sessionId, title);
  } catch {
    toast.error(t('mobile.sessions.renameError'));
  }
};
