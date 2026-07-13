import React from 'react';
import { cn } from '@/lib/utils';
import { useMultiHostStore } from '@/multi-host';
import type { HostId, HostSessionRef } from '@/multi-host';
import { HostNode } from './HostNode';
import { MultiHostEmptyState } from './MultiHostEmptyState';
import type { SessionExtraStatus } from './multi-host-sidebar-types';
import { hostFoldKey } from './multi-host-sidebar-types';

export type MultiHostSessionTreeProps = {
  activeHostId?: HostId;
  activeSessionId?: string;
  activationPendingRef?: HostSessionRef | null;
  sessionExtras?: Record<HostId, Record<string, SessionExtraStatus>>;
  onActivateSession: (ref: HostSessionRef) => void | Promise<void>;
  className?: string;
};

export function MultiHostSessionTree({
  activeHostId,
  activeSessionId,
  activationPendingRef,
  sessionExtras,
  onActivateSession,
  className,
}: MultiHostSessionTreeProps) {
  // Subscribe only to host IDs — not the full state
  const hostIds = useMultiHostStore(
    (s) => Object.keys(s.hosts) as HostId[],
  );

  // Stable reference comparison for hostIds array
  const [collapsedHosts, setCollapsedHosts] = React.useState<
    Record<string, boolean>
  >({});
  const [collapsedProjects, setCollapsedProjects] = React.useState<
    Record<string, boolean>
  >({});

  const sortedHostIds = React.useMemo(
    () => [...hostIds].sort(),
    [hostIds],
  );

  const handleToggleHostCollapse = React.useCallback((key: string) => {
    setCollapsedHosts((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

  const handleToggleProjectCollapse = React.useCallback((key: string) => {
    setCollapsedProjects((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

  if (sortedHostIds.length === 0) {
    return (
      <div className={cn('flex-1 overflow-y-auto', className)}>
        <MultiHostEmptyState />
      </div>
    );
  }

  return (
    <div className={cn('flex-1 overflow-y-auto', className)}>
      <div className="py-1">
        {sortedHostIds.map((hostId) => (
          <HostNode
            key={`host:${hostId}`}
            hostId={hostId}
            activeHostId={activeHostId}
            activeSessionId={activeSessionId}
            activationPendingRef={activationPendingRef}
            sessionExtras={sessionExtras}
            isCollapsed={collapsedHosts[hostFoldKey(hostId)] ?? false}
            collapsedProjects={collapsedProjects}
            onToggleHostCollapse={() =>
              handleToggleHostCollapse(hostFoldKey(hostId))
            }
            onToggleProjectCollapse={handleToggleProjectCollapse}
            onActivateSession={onActivateSession}
          />
        ))}
      </div>
    </div>
  );
}
