import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { HostId, HostSessionRef } from '@/multi-host';
import { useHost } from '@/multi-host';
import { HostConnectionIndicator } from './HostConnectionIndicator';
import { HostProjectNode } from './HostProjectNode';
import { HostStatusBadge } from './HostStatusBadge';
import type {
  ProjectGroup,
  SessionExtraStatus,
} from './multi-host-sidebar-types';
import { deriveSessionStatus, projectFoldKey } from './multi-host-sidebar-types';

type HostNodeProps = {
  hostId: HostId;
  activeHostId?: HostId;
  activeSessionId?: string;
  activationPendingRef?: HostSessionRef | null;
  sessionExtras?: Record<HostId, Record<string, SessionExtraStatus>>;
  isCollapsed: boolean;
  collapsedProjects: Record<string, boolean>;
  onToggleHostCollapse: () => void;
  onToggleProjectCollapse: (key: string) => void;
  onActivateSession: (ref: HostSessionRef) => void;
};

function buildProjectGroups(
  hostId: HostId,
  sessions: Record<string, { projectId?: string; directory?: string; title?: string; updatedAt?: number; id: string }>,
  statuses: Record<string, { status: 'idle' | 'busy' | 'retry' }>,
  unreadBySession: Record<string, number>,
  sessionExtras?: Record<string, SessionExtraStatus>,
): ProjectGroup[] {
  const projectMap = new Map<string, ProjectGroup>();

  for (const [sessionId, session] of Object.entries(sessions)) {
    const projectId = session.projectId || 'unknown';
    const directory = session.directory || '';
    const projectName = directory.split('/').pop() || projectId;

    if (!projectMap.has(projectId)) {
      projectMap.set(projectId, {
        projectId,
        projectName,
        directory,
        sessions: [],
        unreadCount: 0,
        sessionCount: 0,
      });
    }

    const group = projectMap.get(projectId)!;
    const unread = unreadBySession[sessionId] ?? 0;
    const extra = sessionExtras?.[sessionId];
    const derivedStatus = deriveSessionStatus(statuses[sessionId], unread, extra);

    const sessionRef: HostSessionRef = {
      hostId,
      sessionId,
      directory,
      projectId,
    };

    group.sessions.push({
      ref: sessionRef,
      session,
      status: derivedStatus,
      unreadCount: unread,
    });
    group.unreadCount += unread;
    group.sessionCount += 1;
  }

  return Array.from(projectMap.values());
}

export const HostNode = React.memo(function HostNode({
  hostId,
  activeHostId,
  activeSessionId,
  activationPendingRef,
  sessionExtras,
  isCollapsed,
  collapsedProjects,
  onToggleHostCollapse,
  onToggleProjectCollapse,
  onActivateSession,
}: HostNodeProps) {
  const host = useHost(hostId);

  const projectGroups = React.useMemo(() => {
    if (!host) return [];
    const extras = sessionExtras?.[hostId];
    return buildProjectGroups(
      hostId,
      host.sessions,
      host.statuses,
      host.unreadBySession,
      extras,
    );
  }, [host, hostId, sessionExtras]);

  const summary = React.useMemo(() => {
    if (!host) return null;

    let unreadTotal = 0;
    let waitingPermissionCount = 0;
    let waitingQuestionCount = 0;
    let hasBusySession = false;
    const extras = sessionExtras?.[hostId];

    for (const count of Object.values(host.unreadBySession)) {
      unreadTotal += count;
    }
    for (const sessionStatus of Object.values(host.statuses)) {
      if (sessionStatus.status === 'busy') hasBusySession = true;
    }
    if (extras) {
      for (const extra of Object.values(extras)) {
        if (extra.hasWaitingPermission) waitingPermissionCount += 1;
        if (extra.hasWaitingQuestion) waitingQuestionCount += 1;
      }
    }

    return {
      unreadTotal,
      waitingPermissionCount,
      waitingQuestionCount,
      hasBusySession,
      sessionCount: Object.keys(host.sessions).length,
    };
  }, [host, hostId, sessionExtras]);

  const handleToggleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggleHostCollapse();
      }
    },
    [onToggleHostCollapse],
  );

  if (!host) return null;

  const isActiveHost = activeHostId === hostId;

  return (
    <div
      className={cn(
        'mb-1',
        isActiveHost && 'rounded-md bg-[var(--interactive-selection)]/30',
      )}
    >
      {/* Host header */}
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
          'hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        )}
        onClick={onToggleHostCollapse}
        onKeyDown={handleToggleKeyDown}
        aria-expanded={!isCollapsed}
        aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${host.descriptor.label}`}
      >
        <Icon
          name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">
          {host.descriptor.label}
        </span>
      </button>

      {/* Connection indicator */}
      {!isCollapsed && (
        <div className="ml-6 mb-1">
          <HostConnectionIndicator
            connection={host.connection}
            transport={host.descriptor.transport}
          />
        </div>
      )}

      {/* Collapsed summary */}
      {isCollapsed && summary && (
        <div className="ml-6 mb-1 flex items-center gap-2">
          <HostConnectionIndicator
            connection={host.connection}
            transport={host.descriptor.transport}
          />
          {summary.unreadTotal > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]" />
              <span className="text-[0.6rem] typography-meta text-[var(--status-info)]">
                {summary.unreadTotal}
              </span>
            </span>
          )}
          {summary.waitingPermissionCount > 0 && (
            <HostStatusBadge
              status="waiting-permission"
              count={summary.waitingPermissionCount}
            />
          )}
          {summary.waitingQuestionCount > 0 && (
            <HostStatusBadge
              status="waiting-question"
              count={summary.waitingQuestionCount}
            />
          )}
          {summary.hasBusySession && (
            <HostStatusBadge status="busy" />
          )}
        </div>
      )}

      {/* Expanded projects */}
      {!isCollapsed && (
        <div className="ml-1">
          {projectGroups.length === 0 && (
            <div className="px-4 py-2 text-[0.7rem] typography-meta text-muted-foreground">
              No sessions
            </div>
          )}
          {projectGroups.map((project) => (
            <HostProjectNode
              key={`project:${hostId}:${project.projectId}`}
              hostId={hostId}
              project={project}
              activeSessionId={activeSessionId}
              activationPendingSessionId={activationPendingRef?.hostId === hostId ? activationPendingRef.sessionId : undefined}
              sessionExtras={sessionExtras?.[hostId]}
              isCollapsed={collapsedProjects[projectFoldKey(hostId, project.projectId)] ?? false}
              onToggleCollapse={() =>
                onToggleProjectCollapse(projectFoldKey(hostId, project.projectId))
              }
              onActivateSession={onActivateSession}
            />
          ))}
        </div>
      )}
    </div>
  );
});
