import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from '../types';
import type { SidebarSessionLocation } from './sessionLocation';

type SidebarActivityItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null; inSpace?: boolean } | null;
  getSecondaryMeta?: (sessionId: string) => SidebarActivityItem['secondaryMeta'];
};

// The rows of a zone's sessions. Ordering, membership, and branch/project
// metadata are resolved by the caller; this projection only shapes rows.
export const deriveTimelineActivityItems = ({
  sessions,
  getSessionLocation,
  getSessionNode,
}: {
  sessions: readonly Session[];
  getSessionLocation: (sessionId: string) => SidebarSessionLocation | null;
  getSessionNode: (session: Session) => SessionNode;
}): SidebarActivityItem[] => sessions.map((session) => {
  const location = getSessionLocation(session.id);
  return {
    node: getSessionNode(session),
    projectId: location?.projectId ?? null,
    groupDirectory: location?.groupDirectory ?? session.directory ?? null,
    secondaryMeta: {
      projectLabel: location?.projectLabel ?? null,
      branchLabel: location?.branchLabel ?? null,
      inSpace: location?.inSpace ?? false,
    },
  };
});
