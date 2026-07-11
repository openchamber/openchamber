import type { SessionNavigationTarget } from './session-navigation';

const MAX_NUMBERED_SIDEBAR_SESSIONS = 9;

type SidebarNumberedNavigationSnapshot = Readonly<{
  targets: readonly SessionNavigationTarget[];
  activate: (target: SessionNavigationTarget) => void;
}>;

let publishedSnapshot: SidebarNumberedNavigationSnapshot | null = null;
let publishedRevision = 0;

/**
 * Build the global Mod+1…9 order from the session rows that are logically
 * visible in the sidebar. Recent rows come first because that section renders
 * above the project tree; project rows retain their rendered tree order.
 *
 * A session may intentionally appear twice (Recent and its project). Those are
 * distinct visual rows with distinct Focus identities, so both keep a slot.
 */
export const buildSidebarNumberedSessionTargets = ({
  recentTargets,
  projectTargets,
}: {
  recentTargets: readonly SessionNavigationTarget[];
  projectTargets: readonly SessionNavigationTarget[];
}): SessionNavigationTarget[] => (
  [...recentTargets, ...projectTargets].slice(0, MAX_NUMBERED_SIDEBAR_SESSIONS)
);

export const getSidebarNumberedSessionNumber = (
  targets: readonly SessionNavigationTarget[],
  focus: Pick<SessionNavigationTarget, 'scope' | 'sessionId' | 'projectId'>,
): number | null => {
  const index = targets.findIndex((target) => (
    target.scope === focus.scope
    && target.sessionId === focus.sessionId
    && (target.projectId ?? null) === (focus.projectId ?? null)
  ));
  return index >= 0 ? index + 1 : null;
};

/**
 * Publish the exact numbered session order currently rendered by the sidebar.
 * Cleanup is revision-scoped so an older responsive/sidebar tree cannot clear
 * a newer publisher during remount.
 */
export const publishSidebarNumberedNavigation = (
  snapshot: SidebarNumberedNavigationSnapshot,
): (() => void) => {
  const revision = ++publishedRevision;
  publishedSnapshot = {
    targets: snapshot.targets.slice(0, MAX_NUMBERED_SIDEBAR_SESSIONS),
    activate: snapshot.activate,
  };

  return () => {
    if (publishedRevision === revision) {
      publishedSnapshot = null;
    }
  };
};

export const activateSidebarNumberedSession = (slotNumber: number): boolean => {
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > MAX_NUMBERED_SIDEBAR_SESSIONS) {
    return false;
  }

  const snapshot = publishedSnapshot;
  const target = snapshot?.targets[slotNumber - 1];
  if (!snapshot || !target) {
    return false;
  }

  snapshot.activate(target);
  return true;
};

export const clearSidebarNumberedNavigation = (): void => {
  publishedRevision += 1;
  publishedSnapshot = null;
};
