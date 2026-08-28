import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';
import { createSessionOwnershipIndex } from './sessionOwnership';

type Project = {
  id: string;
  path: string;
  sidebarCollapsed?: boolean;
};

type Worktree = {
  path: string;
};

const EMPTY_LIVE_SESSION_IDS: ReadonlySet<string> = new Set();

type BackgroundDiscoveryOwnership = {
  activeProjectId: string | null;
  sessionsByProject: ReadonlyMap<string, Session[]>;
  liveSessionIds: ReadonlySet<string>;
};

// A collapsed project keeps its historical sessions forever, so session
// ownership alone would keep every project the user ever used permanently
// eligible for background work. Collapsed projects need a running session.
export const isProjectEligibleForBackgroundDiscovery = (
  project: { id: string; sidebarCollapsed?: boolean },
  ownership: BackgroundDiscoveryOwnership,
): boolean => {
  if (project.id === ownership.activeProjectId) return true;
  const ownedSessions = ownership.sessionsByProject.get(project.id);
  if (!ownedSessions?.length) return false;
  if (!project.sidebarCollapsed) return true;
  return ownedSessions.some((session) => ownership.liveSessionIds.has(session.id));
};

export const selectWorktreeDiscoveryProjects = <TProject extends Project>(
  projects: TProject[],
  activeProjectId: string | null,
  sessions: Session[],
  availableWorktreesByProject: Map<string, Worktree[]>,
  isVSCode = false,
  liveSessionIds: ReadonlySet<string> = EMPTY_LIVE_SESSION_IDS,
): TProject[] => {
  const ownershipProjects = projects.map((project) => ({
    id: project.id,
    normalizedPath: normalizePath(project.path) ?? project.path,
  }));
  const ownership = createSessionOwnershipIndex(
    sessions,
    ownershipProjects,
    availableWorktreesByProject,
    isVSCode,
  );

  return projects.filter((project) => isProjectEligibleForBackgroundDiscovery(project, {
    activeProjectId,
    sessionsByProject: ownership.sessionsByProject,
    liveSessionIds,
  }));
};
