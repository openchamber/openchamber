import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { getSessionLifecycleOrderValue } from '@/sync/session-ordering';

/** The fields any project list needs to be sortable. Both the desktop sidebar
    and the mobile sessions drawer build their own richer project shapes on top
    of the store entries, so this stays structural. */
export type SortableProject = {
  id: string;
  label?: string | null;
  path: string;
  addedAt?: number | null;
  lastOpenedAt?: number | null;
};

const compareLabels = (left: SortableProject, right: SortableProject): number =>
  (left.label || left.path).toLowerCase().localeCompare((right.label || right.path).toLowerCase());

/** One ordering for every surface that lists projects, so the sidebar and the
    mobile drawer answer the same setting the same way. `manualOrder` is the
    user's drag order (`useProjectsStore.manualProjectOrder`); projects missing
    from it keep their incoming position at the end. */
export const sortProjectsByOrder = <T extends SortableProject>(
  projects: readonly T[],
  order: ProjectSortOrder,
  manualOrder: readonly string[],
): T[] => {
  const sorted = [...projects];

  switch (order) {
    case 'a-z':
      sorted.sort(compareLabels);
      break;
    case 'z-a':
      sorted.sort((left, right) => compareLabels(right, left));
      break;
    case 'date-added':
      sorted.sort((left, right) => (right.addedAt ?? 0) - (left.addedAt ?? 0));
      break;
    case 'recent':
      sorted.sort((left, right) => (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0));
      break;
    case 'manual': {
      const rankById = new Map(manualOrder.map((id, index) => [id, index]));
      sorted.sort((left, right) => (rankById.get(left.id) ?? Infinity) - (rankById.get(right.id) ?? Infinity));
      break;
    }
  }

  return sorted;
};

/** Live-session signal for one project, computed where its sessions are known. */
export type ProjectActivitySignal = {
  /** At least one owned session is in the authoritative non-idle status set. */
  hasActiveSession: boolean;
  /**
   * Latest lifecycle order value (`getSessionLifecycleOrderValue`) among the
   * project's non-archived sessions. Live ranks and timestamp baselines share
   * the `lastOpenedAt` epoch-ms scale, so the two can be compared directly.
   */
  latestSessionActivityAt: number;
};

/**
 * Project-zone ordering for the sidebar's live-session requirement.
 *
 * `recent` and `date-added` promote projects that own a running session above
 * projects without one; inside each tier the incoming (mode-sorted) order is
 * preserved. `recent` also folds the latest session lifecycle value into the
 * recency key, so a project that just ran rises even when `lastOpenedAt` is
 * old. Other modes return the input untouched.
 *
 * Returns the input array when nothing moved so callers keep memo identity.
 */
export const orderProjectsByLiveActivity = <T extends SortableProject>(
  projects: T[],
  order: ProjectSortOrder,
  activityByProjectId: ReadonlyMap<string, ProjectActivitySignal>,
): T[] => {
  if (order !== 'recent' && order !== 'date-added') return projects;

  const ranked = projects.map((project, index) => ({ project, index }));
  ranked.sort((left, right) => {
    const leftActive = activityByProjectId.get(left.project.id)?.hasActiveSession === true;
    const rightActive = activityByProjectId.get(right.project.id)?.hasActiveSession === true;
    if (leftActive !== rightActive) return leftActive ? -1 : 1;

    if (order === 'recent') {
      const leftActivity = activityByProjectId.get(left.project.id)?.latestSessionActivityAt ?? 0;
      const rightActivity = activityByProjectId.get(right.project.id)?.latestSessionActivityAt ?? 0;
      const leftRecent = Math.max(left.project.lastOpenedAt ?? 0, leftActivity);
      const rightRecent = Math.max(right.project.lastOpenedAt ?? 0, rightActivity);
      if (leftRecent !== rightRecent) return rightRecent - leftRecent;
    }

    return left.index - right.index;
  });

  const moved = ranked.some((entry, index) => entry.project !== projects[index]);
  return moved ? ranked.map((entry) => entry.project) : projects;
};

type ProjectActivityInput = {
  /** Every project the result map is keyed by; unknown ids are ignored. */
  projectIds: readonly string[];
  /** Sessions to measure — callers pass the same non-archived set they render. */
  sessions: readonly Session[];
  /** Authoritative non-idle session ids (`global-session-status`). */
  activeSessionIds: ReadonlySet<string>;
  sessionOrderRanks: ReadonlyMap<string, number>;
  /** Session → owning project; null when no registered project owns it. */
  resolveProjectId: (session: Session) => string | null;
};

/**
 * Projects the shared live-activity signal from a flat session list. Mobile
 * owns a single flattened tree and supplies its own project matcher; desktop
 * already has per-project ownership lists and derives the same signal inline
 * in `useSessionSidebarSections`.
 */
export const deriveProjectActivityByProjectId = ({
  projectIds,
  sessions,
  activeSessionIds,
  sessionOrderRanks,
  resolveProjectId,
}: ProjectActivityInput): ReadonlyMap<string, ProjectActivitySignal> => {
  const activityByProjectId = new Map<string, ProjectActivitySignal>();
  for (const projectId of projectIds) {
    activityByProjectId.set(projectId, { hasActiveSession: false, latestSessionActivityAt: 0 });
  }

  for (const session of sessions) {
    const projectId = resolveProjectId(session);
    if (!projectId) continue;
    const current = activityByProjectId.get(projectId);
    if (!current) continue;
    activityByProjectId.set(projectId, {
      hasActiveSession: current.hasActiveSession || activeSessionIds.has(session.id),
      latestSessionActivityAt: Math.max(
        current.latestSessionActivityAt,
        getSessionLifecycleOrderValue(session, sessionOrderRanks),
      ),
    });
  }

  return activityByProjectId;
};
