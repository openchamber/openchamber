import React from 'react';

import type { Session } from '@/lib/opencode/model';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { isLeadSession } from '@/lib/sessionLead';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function useProjectLeads(projectId: string | null, exceptSessionId: string): Session[] {
  const sessions = useGlobalSessionsStore((state) => state.activeSessions);
  const projects = useProjectsStore((state) => state.projects);
  const worktrees = useSessionUIStore((state) => state.availableWorktreesByProject);
  return React.useMemo(() => {
    if (!projectId) return [];
    return sessions.filter((session) => session.id !== exceptSessionId
      && isLeadSession(session)
      && resolveProjectForSessionDirectory(projects, worktrees, session.directory ?? null)?.id === projectId);
  }, [exceptSessionId, projectId, projects, sessions, worktrees]);
}
