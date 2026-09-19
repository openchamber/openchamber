import type { Session } from '@opencode-ai/sdk/v2';
import { formatDirectoryName } from '@/lib/utils';
import type { DirectoryOwner } from '../sessions/sessionOwnership';
import type { SessionNode } from '../types';
import { formatProjectLabel, normalizePath } from '../utils';

export type RecentSessionLocation = {
  projectId: string | null;
  groupDirectory: string | null;
  projectLabel: string | null;
  branchLabel: string | null;
};

// Recent rows resolve their owner through the shared ownership index, not by
// re-matching directory prefixes: the index already covers linked worktrees
// and the canonical-project fallback for restored sessions whose worktree
// directory no longer exists. The row keeps the session's own directory; only
// display ownership comes from the index.
export const buildRecentSessionLocations = (args: {
  sessions: readonly Session[];
  sessionOwners: ReadonlyMap<string, DirectoryOwner>;
  projects: ReadonlyArray<{ id: string; normalizedPath: string; label?: string }>;
  availableWorktreesByProject: ReadonlyMap<string, ReadonlyArray<{ path: string; branch?: string | null }>>;
  gitBranches: ReadonlyMap<string, string | null>;
  homeDirectory: string | null;
}): Map<string, RecentSessionLocation> => {
  const locations = new Map<string, RecentSessionLocation>();
  const projectsById = new Map(args.projects.map((project) => [project.id, project]));
  for (const session of args.sessions) {
    const owner = args.sessionOwners.get(session.id);
    if (!owner) continue;
    const project = projectsById.get(owner.projectId);
    if (!project) continue;
    const directory = normalizePath(session.directory ?? null);
    const worktree = directory
      ? args.availableWorktreesByProject.get(owner.projectRoot)?.find((entry) => normalizePath(entry.path) === directory)
      : undefined;
    const projectLabel = formatProjectLabel(
      project.label?.trim() || formatDirectoryName(project.normalizedPath, args.homeDirectory) || project.normalizedPath,
    );
    const branch = worktree?.branch?.trim()
      || (directory ? args.gitBranches.get(directory)?.trim() : undefined)
      || null;
    locations.set(session.id, {
      projectId: project.id,
      groupDirectory: directory,
      projectLabel,
      branchLabel: branch && branch !== 'HEAD' && branch !== projectLabel ? branch : null,
    });
  }
  return locations;
};

type RecentActivitySection = {
  key: 'active-now';
  items: Array<{
    node: SessionNode;
    projectId: string | null;
    groupDirectory: string | null;
    secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null } | null;
  }>;
};

const RECENT_SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const isSubtaskSession = (session: Session): boolean => {
  return Boolean((session as Session & { parentID?: string | null }).parentID);
};

const isArchivedSession = (session: Session): boolean => {
  return Boolean(session.time?.archived);
};

const getSessionUpdatedAt = (session: Session): number => {
  const updated = session.time?.updated;
  const created = session.time?.created;
  if (typeof updated === 'number' && Number.isFinite(updated)) {
    return updated;
  }
  if (typeof created === 'number' && Number.isFinite(created)) {
    return created;
  }
  return 0;
};

// Recent contains non-archived root sessions that are active now or were
// updated within the retention window. The caller applies shared lifecycle
// ordering after this membership filter; batching ("Show more") handles long
// windows in the UI.
export const deriveRecentSessions = (
  sessions: Session[],
  activeSessionIds: ReadonlySet<string>,
  now = Date.now(),
): Session[] => {
  const minUpdatedAt = now - RECENT_SESSION_MAX_AGE_MS;
  return sessions.filter((session) => {
    if (isArchivedSession(session) || isSubtaskSession(session)) {
      return false;
    }
    return activeSessionIds.has(session.id) || getSessionUpdatedAt(session) >= minUpdatedAt;
  });
};

export const deriveRecentActivitySections = ({
  sessions,
  getSessionLocation,
  getSessionNode,
  query,
}: {
  sessions: Session[];
  getSessionLocation: (sessionId: string) => RecentSessionLocation | null;
  getSessionNode?: (session: Session) => SessionNode;
  query: string;
}): RecentActivitySection[] => [{
  key: 'active-now',
  items: sessions.flatMap((session) => {
    const title = typeof session.title === 'string' ? session.title.toLowerCase() : '';
    const normalizedQuery = query.trim().toLowerCase();
    const isIdQuery = normalizedQuery.startsWith('ses_');
    const matches = isIdQuery
      ? session.id.toLowerCase() === normalizedQuery
      : !query || title.includes(query);
    if (!matches) return [];
    const location = getSessionLocation(session.id);
    return [{
      node: getSessionNode?.(session) ?? { session, children: [], worktree: null },
      projectId: location?.projectId ?? null,
      groupDirectory: location?.groupDirectory ?? session.directory ?? null,
      secondaryMeta: location ? {
        projectLabel: location.projectLabel,
        branchLabel: location.branchLabel,
      } : null,
    }];
  }),
}];
