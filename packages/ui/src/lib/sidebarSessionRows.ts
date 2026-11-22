import type { Session } from '@/lib/opencode/model';
import { isBtwSession } from '@/lib/sessionBtwMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';

export const sessionHasSidebarRow = (
  session: Session,
  { isAdmitted, isPlaced, isPinned, zones }: { isAdmitted: boolean; isPlaced: boolean; isPinned: boolean; zones: { pinned: boolean; work: boolean } },
): boolean => {
  if (!isAdmitted || session.parentID || session.time?.archived || isBtwSession(session)) return false;
  return isPlaced || (zones.pinned && isPinned) || (zones.work && isSessionInWork(session));
};
