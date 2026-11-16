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

/** Where a session row sits: its folder, project and selection scope, and whether the screen shows it. */
export function useSessionRowPlace({
  session,
  groupDirectory,
  projectId,
  ownerProjectId,
  selectionScopeKey: explicitSelectionScopeKey,
  folderOwnerKey,
}: SessionRowPlaceInput) {
  // The row is selected while its session is what the screen shows: a run's
  // overview covers it, and then the run's row is the selected one.
  const isCurrentSession = useSessionUIStore((state) => state.currentSessionId === session.id);
  const runOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
  const isActive = isCurrentSession && !runOverviewOpen;

  const sessionDirectory = normalizePath(session.directory ?? null) ?? normalizePath(groupDirectory ?? null);
  const sessionProjectId = ownerProjectId === undefined ? projectId : ownerProjectId;
  // A nested cross-project row uses its own repository for Tracker links.
  // The project root also resolves before the live worktree map arrives.
  const projectRootDirectory = useProjectsStore((state) =>
    sessionProjectId ? state.projects.find((entry) => entry.id === sessionProjectId)?.path ?? null : null,
  );
  const trackerDirectory = projectRootDirectory ?? sessionDirectory;
  // Multi-select scope: sessions are flat per project, so selection groups by
  // project (falling back to the directory when no project is known) — a
  // selection must survive mixing sessions from different worktrees.
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
