import type { Session } from '@/lib/opencode/model';
import { isBtwSession } from '@/lib/sessionBtwMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';

/**
 * Whether a top-level session has a row in the sidebar: a /btw fork never does
 * (`partitionSidebarSessions`), a session the sidebar can place under a
 * project, worktree, chat or space does, and so does a pinned or in-work
 * session while its zone renders (`zones`, as `SessionProjectCollection`
 * gates them), since the Pinned and In work zones list it whether or not its
 * project still exists, provided its destination is admitted. Surfaces that list sessions outside the sidebar (the
 * desktop tray and dock badge) use this, so the two agree.
 */
export const sessionHasSidebarRow = (
  session: Session,
  { isAdmitted, isPlaced, isPinned, zones }: { isAdmitted: boolean; isPlaced: boolean; isPinned: boolean; zones: { pinned: boolean; work: boolean } },
): boolean => {
  if (!isAdmitted || session.parentID || session.time?.archived || isBtwSession(session)) return false;
  return isPlaced || (zones.pinned && isPinned) || (zones.work && isSessionInWork(session));
};
