import type { Session } from '@/lib/opencode/model';
import { isBtwSession } from '@/lib/sessionBtwMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';

/**
 * Whether a top-level session has a row in the sidebar, by the rules that hold
 * in every sidebar layout: a /btw fork never does (`partitionSidebarSessions`),
 * a session the sidebar can place under a project, worktree, chat or space
 * does, and so does a pinned or in-work session, which the Pinned and In work
 * zones list whether or not its project still exists. Surfaces that list
 * sessions outside the sidebar (the desktop tray) use this, so the two agree.
 */
export const sessionHasSidebarRow = (
  session: Session,
  { isPlaced, isPinned }: { isPlaced: boolean; isPinned: boolean },
): boolean => {
  if (session.parentID || session.time?.archived || isBtwSession(session)) return false;
  return isPlaced || isPinned || isSessionInWork(session);
};
