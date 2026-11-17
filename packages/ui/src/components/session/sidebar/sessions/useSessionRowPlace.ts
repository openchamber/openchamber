import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '../utils';

type SessionRowPlaceInput = {
  session: Session;
  groupDirectory: string | null | undefined;
  projectId: string | null | undefined;
  ownerProjectId: string | null | undefined;
  selectionScopeKey: string | null | undefined;
  folderOwnerKey: string | null | undefined;
};

export function useSessionRowPlace({
  session,
  groupDirectory,
  projectId,
  ownerProjectId,
  selectionScopeKey: explicitSelectionScopeKey,
  folderOwnerKey,
}: SessionRowPlaceInput) {
  const isCurrentSession = useSessionUIStore((state) => state.currentSessionId === session.id);
  const runOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
  const isActive = isCurrentSession && !runOverviewOpen;

  const sessionDirectory = normalizePath(session.directory ?? null) ?? normalizePath(groupDirectory ?? null);
  const sessionProjectId = ownerProjectId === undefined ? projectId : ownerProjectId;
  const projectRootDirectory = useProjectsStore((state) =>
    sessionProjectId ? state.projects.find((entry) => entry.id === sessionProjectId)?.path ?? null : null,
  );
  const trackerDirectory = projectRootDirectory ?? sessionDirectory;
  const selectionScopeKey = explicitSelectionScopeKey !== undefined
    ? explicitSelectionScopeKey
    : projectId ?? sessionDirectory ?? null;
  const hasFolderMutationAuthority = folderOwnerKey === undefined ? true : Boolean(folderOwnerKey);
  return {
    isCurrentSession,
    isActive,
    sessionDirectory,
    sessionProjectId,
    projectRootDirectory,
    trackerDirectory,
    selectionScopeKey,
    hasFolderMutationAuthority,
  };
}
