import React from 'react';
import { useSubagentSessions } from '@/hooks/useSubagentSessions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import type { SubagentSession } from '@/hooks/useSubagentSessions';

const formatDurationMs = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ${Math.floor(seconds % 60)}s`;
  const hours = minutes / 60;
  return `${Math.floor(hours)}h ${Math.floor(minutes % 60)}m`;
};

const DepthIndicator: React.FC<{ depth: number }> = ({ depth }) => {
  if (depth <= 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: Math.min(depth, 3) }).map((_, idx) => (
        <span key={idx} className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
      ))}
      {depth > 3 && <span className="typography-meta text-muted-foreground">+{depth - 3}</span>}
    </span>
  );
};

const SubagentRow: React.FC<{
  session: SubagentSession;
  onClick: (session: SubagentSession) => void;
}> = ({ session, onClick }) => {
  const statusColor =
    session.phase === 'busy'
      ? 'text-status-busy'
      : session.phase === 'retry'
        ? 'text-status-retry'
        : 'text-muted-foreground';

  const statusIcon: 'loader-4' | 'refresh' | 'check' =
    session.phase === 'busy'
      ? 'loader-4'
      : session.phase === 'retry'
        ? 'refresh'
        : 'check';

  const title = session.title?.trim() || 'New session';

  return (
    <button
      type="button"
      onClick={() => onClick(session)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
      )}
      style={{ paddingLeft: `${12 + session.depth * 12}px` }}
    >
      <Icon
        name={statusIcon}
        className={cn('h-3.5 w-3.5 flex-shrink-0', session.phase === 'busy' && 'animate-spin', statusColor)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="typography-sm truncate text-foreground">{title}</span>
        <span className="typography-meta flex items-center gap-1.5 text-muted-foreground">
          <DepthIndicator depth={session.depth} />
          {session.elapsedMs !== null && (
            <span>{formatDurationMs(session.elapsedMs)}</span>
          )}
        </span>
      </div>
    </button>
  );
};

export const SubagentsPanel: React.FC = () => {
  const directory = useEffectiveDirectory();
  const sessions = useSubagentSessions(directory ?? '');
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);

  const handleSessionClick = React.useCallback(
    (session: SubagentSession) => {
      if (!directory) return;
      setCurrentSession(session.id, directory);
    },
    [directory, setCurrentSession]
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="typography-sm font-medium text-foreground">Subagents</h2>
        <span className="typography-meta text-muted-foreground">
          {sessions.filter((s) => s.phase !== 'idle').length}
          {sessions.length > 0 && ` / ${sessions.length}`}
        </span>
      </div>

      <ScrollShadow className="min-h-0 flex-1">
        <div className="space-y-0.5 p-1.5">
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 px-3 text-center">
              <Icon name="user-3" className="h-8 w-8 text-muted-foreground/50" />
              <p className="typography-sm text-muted-foreground">No active subagents</p>
            </div>
          ) : (
            sessions.map((session) => (
              <SubagentRow
                key={session.id}
                session={session}
                onClick={handleSessionClick}
              />
            ))
          )}
        </div>
      </ScrollShadow>
    </div>
  );
};

SubagentsPanel.displayName = 'SubagentsPanel';
