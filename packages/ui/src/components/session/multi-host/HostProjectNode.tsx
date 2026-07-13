import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { HostSessionRef } from '@/multi-host';
import type {
  DerivedSessionStatus,
  ProjectGroup,
  SessionExtraStatus,
} from './multi-host-sidebar-types';
import { HostSessionNode } from './HostSessionNode';

type HostProjectNodeProps = {
  hostId: string;
  project: ProjectGroup;
  activeSessionId?: string;
  activationPendingSessionId?: string;
  sessionExtras?: Record<string, SessionExtraStatus>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onActivateSession: (ref: HostSessionRef) => void;
};

export const HostProjectNode = React.memo(function HostProjectNode({
  hostId,
  project,
  activeSessionId,
  activationPendingSessionId,
  sessionExtras,
  isCollapsed,
  onToggleCollapse,
  onActivateSession,
}: HostProjectNodeProps) {
  const handleToggleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggleCollapse();
      }
    },
    [onToggleCollapse],
  );

  const sortedSessions = React.useMemo(() => {
    return [...project.sessions].sort((a, b) => {
      const priority: Record<DerivedSessionStatus, number> = {
        'waiting-permission': 0,
        'waiting-question': 1,
        error: 2,
        busy: 3,
        retry: 4,
        unread: 5,
        idle: 6,
      };
      const pa = priority[a.status];
      const pb = priority[b.status];
      if (pa !== pb) return pa - pb;
      return (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0);
    });
  }, [project.sessions]);

  return (
    <div className="ml-2">
      {/* Project header */}
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left',
          'hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        )}
        onClick={onToggleCollapse}
        onKeyDown={handleToggleKeyDown}
        aria-expanded={!isCollapsed}
        aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${project.projectName}`}
      >
        <Icon
          name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
        <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
          {project.projectName}
        </span>
        <span className="shrink-0 text-[0.6rem] typography-meta text-muted-foreground">
          {project.sessionCount}
        </span>
        {project.unreadCount > 0 && (
          <span className="inline-flex items-center gap-0.5 shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]" />
            <span className="text-[0.6rem] typography-meta text-[var(--status-info)]">
              {project.unreadCount}
            </span>
          </span>
        )}
      </button>

      {/* Sessions */}
      {!isCollapsed && (
        <div className="ml-3">
          {sortedSessions.map((ps) => {
            const sessionRef: HostSessionRef = {
              hostId: hostId as never,
              sessionId: ps.ref.sessionId,
              directory: ps.ref.directory,
              projectId: ps.ref.projectId,
            };
            return (
              <HostSessionNode
                key={`session:${hostId}:${ps.ref.sessionId}`}
                ref={sessionRef}
                session={ps.session}
                derivedStatus={ps.status}
                unreadCount={ps.unreadCount}
                isActive={activeSessionId === ps.ref.sessionId}
                isPending={activationPendingSessionId === ps.ref.sessionId}
                extra={sessionExtras?.[ps.ref.sessionId]}
                onActivate={onActivateSession}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});
