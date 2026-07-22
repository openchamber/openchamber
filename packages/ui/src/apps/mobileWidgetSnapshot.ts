import type { Session } from '@opencode-ai/sdk/v2';

import type { ProjectEntry } from '@/lib/api/types';
import { useUIStore } from '@/stores/useUIStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useNotificationStore } from '@/sync/notification-store';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Builds the lightweight session overview the native iOS widgets render (home medium,
 * lock-screen, Control Center). The widget process can't see the WebView, so the native
 * shell pulls this snapshot via `window.__OPENCHAMBER_WIDGET_SNAPSHOT__()` on
 * background/activate, writes it to the shared App Group, and reloads the widget timelines
 * (see SceneDelegate.writeWidgetSnapshot). Mirrors the sidebar's attention logic so the
 * widget's "needs attention" mark matches the in-app unread dot exactly:
 *   needsAttention = unseenCount > 0 && (!isSubtask || notifyOnSubtasks)
 */

export interface MobileWidgetSession {
  id: string;
  title: string;
  /** True when the session needs attention (unread + honouring the subtask setting). */
  unread: boolean;
  /** Project label for the session's directory (matched project name, else folder name). */
  project: string;
}

export interface MobileWidgetSnapshot {
  /** Runtime instance that owns all session IDs and paths in this snapshot. */
  runtimeKey: string;
  /** Count of sessions needing attention — same signal that drives the app-icon badge. */
  attentionCount: number;
  /** Most-recently-updated top-level sessions, newest first (capped for the medium widget). */
  recentSessions: MobileWidgetSession[];
}

const RECENT_LIMIT = 6;

const parentIdOf = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
};

const normalizeProjectPath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/\/+$/, '');

/** Project label for a session directory: longest matching project's name, else the folder name. */
const projectLabelForDirectory = (directory: string | null, projects: ProjectEntry[]): string => {
  if (!directory) return '';
  let best: ProjectEntry | null = null;
  let bestLen = -1;
  for (const project of projects) {
    const projectPath = normalizeProjectPath(project.path);
    if (directory === projectPath || directory.startsWith(`${projectPath}/`)) {
      if (projectPath.length > bestLen) {
        best = project;
        bestLen = projectPath.length;
      }
    }
  }
  if (best) {
    return best.label?.trim() || basename(best.path);
  }
  return basename(directory);
};

export const buildMobileWidgetSnapshot = (): MobileWidgetSnapshot => {
  const sessions = useGlobalSessionsStore.getState().activeSessions;
  const unseenBySession = useNotificationStore.getState().index.session.unseenCount;
  const notifyOnSubtasks = useUIStore.getState().notifyOnSubtasks;
  const projects = useProjectsStore.getState().projects;

  let attentionCount = 0;
  const topLevel: Array<{ id: string; title: string; updated: number; unread: boolean; project: string }> = [];

  for (const session of sessions) {
    const isSubtask = parentIdOf(session) !== null;
    const unseenCount = unseenBySession[session.id] ?? 0;
    const needsAttention = unseenCount > 0 && (!isSubtask || notifyOnSubtasks);
    if (needsAttention) {
      attentionCount += 1;
    }
    if (!isSubtask) {
      topLevel.push({
        id: session.id,
        title: session.title ?? '',
        updated: session.time?.updated ?? session.time?.created ?? 0,
        unread: needsAttention,
        project: projectLabelForDirectory(resolveGlobalSessionDirectory(session), projects),
      });
    }
  }

  topLevel.sort((a, b) => b.updated - a.updated);
  const recentSessions = topLevel
    .slice(0, RECENT_LIMIT)
    .map(({ id, title, unread, project }) => ({ id, title, unread, project }));

  return { runtimeKey: getRuntimeKey(), attentionCount, recentSessions };
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
