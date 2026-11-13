import type { Session } from '@/lib/opencode/model';

import type { ProjectEntry } from '@/lib/api/types';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { isSessionUnread } from '@/sync/session-unread';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Builds the lightweight session overview the native widgets render, plus the project list the
 * iOS Shortcuts project picker reads. iOS (home medium, lock-screen, Control Center): the widget
 * process can't see the WebView, so the native shell pulls this snapshot via
 * `window.__OPENCHAMBER_WIDGET_SNAPSHOT__()` on background/activate, writes it to the shared App
 * Group, and reloads the widget timelines (see SceneDelegate.writeWidgetSnapshot). Android: the
 * app pushes the same snapshot to the home-screen widgets (`useNativeWidgetSync`). The "needs
 * attention" mark is the in-app unread mark (`isSessionUnread`), so the widgets and the sidebar
 * agree.
 */

interface MobileWidgetSession {
  id: string;
  title: string;
  /** True when the session's last turn is unread. */
  unread: boolean;
  /** Project label for the session's directory (matched project name, else folder name). */
  project: string;
  /** Live activity from the global status channel; absent when the session is idle. */
  status?: MobileWidgetSessionStatus;
}

type MobileWidgetSessionStatus = 'running' | 'retrying' | 'error';

/** A project the iOS Shortcuts picker offers (ShortcutProjectEntity in ShortcutRequests.swift). */
interface MobileWidgetProject {
  id: string;
  label: string;
}

interface MobileWidgetSnapshot {
  /** Runtime instance that owns all session IDs and paths in this snapshot. */
  runtimeKey: string;
  /** Count of sessions needing attention — same signal that drives the app-icon badge. */
  attentionCount: number;
  /** Top-level sessions in the app's shared lifecycle order (capped for the medium widget). */
  recentSessions: MobileWidgetSession[];
  /** The runtime's projects, for the Shortcuts project picker. */
  projects: MobileWidgetProject[];
}

/** The Android list scrolls through 10; the iOS widgets show at most 6. */
const RECENT_LIMIT = 10;

const parentIdOf = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
};

/**
 * Project label for a session directory, resolved the way the sidebar groups sessions: a
 * worktree or isolated space belongs to the project it was made from. A folder under no
 * project shows its own name.
 */
const projectLabelForDirectory = (directory: string | null, projects: ProjectEntry[]): string => {
  if (!directory) return '';
  const project = resolveProjectForSessionDirectory(
    projects,
    useSessionUIStore.getState().availableWorktreesByProject,
    directory,
  );
  if (project) return project.label?.trim() || basename(project.path);
  return basename(directory);
};

const liveStatusOf = (sessionId: string): MobileWidgetSessionStatus | undefined => {
  const live = useGlobalSessionStatusStore.getState();
  if (live.statusById.get(sessionId)?.status.type === 'retry') return 'retrying';
  if (live.activeSessionIds.has(sessionId)) return 'running';
  // A failed turn stays failed until another run starts (sync/DOCUMENTATION.md).
  if (live.observedById.get(sessionId)?.outcome === 'failed') return 'error';
  return undefined;
};

export const buildMobileWidgetSnapshot = (): MobileWidgetSnapshot => {
  const sessions = useGlobalSessionsStore.getState().activeSessions;
  const projects = useProjectsStore.getState().projects;
  const pinnedSessionIds = useSessionPinnedStore.getState().ids;
  const sessionOrderRanks = useSessionOrderingStore.getState().rankById;

  let attentionCount = 0;
  const topLevel: Array<{ session: Session; unread: boolean; project: string }> = [];

  for (const session of sessions) {
    const unread = isSessionUnread(session);
    if (unread) {
      attentionCount += 1;
    }
    if (parentIdOf(session) === null) {
      topLevel.push({
        session,
        unread,
        project: projectLabelForDirectory(resolveGlobalSessionDirectory(session), projects),
      });
    }
  }

  topLevel.sort((a, b) => compareSessionsByLifecycleOrder(a.session, b.session, pinnedSessionIds, sessionOrderRanks));
  const recentSessions = topLevel
    .slice(0, RECENT_LIMIT)
    .map(({ session, unread, project }) => {
      const row: MobileWidgetSession = { id: session.id, title: session.title ?? '', unread, project };
      const status = liveStatusOf(session.id);
      if (status) row.status = status;
      return row;
    });

  return {
    runtimeKey: getRuntimeKey(),
    attentionCount,
    recentSessions,
    projects: projects.map((project) => ({ id: project.id, label: project.label?.trim() || basename(project.path) })),
  };
};

const SNAPSHOT_GLOBAL_KEY = '__OPENCHAMBER_WIDGET_SNAPSHOT__';

/**
 * Exposes the snapshot builder on `window` so the native shell can read it synchronously via
 * `evaluateJavaScript`. Returns a JSON string (the bridge wants a primitive result) or `null`
 * if building fails, so the native side can skip writing on error rather than clobber a good
 * snapshot. Safe to call in any runtime; only the native iOS shell ever invokes it.
 */
export const installMobileWidgetSnapshotBridge = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  (window as typeof window & { [SNAPSHOT_GLOBAL_KEY]?: () => string | null })[SNAPSHOT_GLOBAL_KEY] = () => {
    try {
      return JSON.stringify(buildMobileWidgetSnapshot());
    } catch {
      return null;
    }
  };
};
