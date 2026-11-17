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


interface MobileWidgetSession {
  id: string;
  title: string;
  unread: boolean;
  project: string;
  status?: MobileWidgetSessionStatus;
}

type MobileWidgetSessionStatus = 'running' | 'retrying' | 'error';

interface MobileWidgetProject {
  id: string;
  label: string;
}

interface MobileWidgetSnapshot {
  runtimeKey: string;
  attentionCount: number;
  recentSessions: MobileWidgetSession[];
  projects: MobileWidgetProject[];
}

const RECENT_LIMIT = 10;

const parentIdOf = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
};

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
