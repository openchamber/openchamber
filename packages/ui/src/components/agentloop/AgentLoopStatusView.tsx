import React from 'react';
import {
  RiCheckLine,
  RiCloseLine,
  RiLoader4Line,
  RiPauseLine,
  RiPlayLine,
  RiSkipForwardLine,
  RiStopLine,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAgentLoopStore } from '@/stores/useAgentLoopStore';
import { useSessionStore } from '@/stores/useSessionStore';
import type { AgentLoopInstance, WorkpackageStatus } from '@/types/agentloop';

const statusConfig: Record<WorkpackageStatus, { icon: React.ElementType; label: string; color: string }> = {
  pending: { icon: RiLoader4Line, label: 'Pending', color: 'text-foreground-muted' },
  running: { icon: RiLoader4Line, label: 'Running', color: 'text-accent' },
  completed: { icon: RiCheckLine, label: 'Done', color: 'text-success' },
  failed: { icon: RiCloseLine, label: 'Failed', color: 'text-destructive' },
  skipped: { icon: RiSkipForwardLine, label: 'Skipped', color: 'text-foreground-muted' },
};

interface AgentLoopStatusViewProps {
  loopId: string;
}

/**
 * Displays the todo-list overview for an active agent loop.
 * Shows workpackage statuses and controls for the loop.
 */
export const AgentLoopStatusView: React.FC<AgentLoopStatusViewProps> = ({ loopId }) => {
  const loop = useAgentLoopStore((s) => s.loops.get(loopId));
  const { pauseLoop, resumeLoop, skipCurrent, stopLoop } = useAgentLoopStore();
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);

  if (!loop) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="typography-body text-foreground-muted">Agent loop not found</p>
      </div>
    );
  }

  const completedCount = loop.workpackages.filter((wp) => wp.status === 'completed').length;
  const totalCount = loop.workpackages.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="typography-heading-lg text-foreground">🔄 {loop.name}</h2>
            <p className="typography-meta text-foreground-muted mt-0.5">
              {completedCount}/{totalCount} tasks completed · {loop.status}
            </p>
          </div>
          <LoopControls loop={loop} onPause={pauseLoop} onResume={resumeLoop} onSkip={skipCurrent} onStop={stopLoop} />
        </div>

        {/* Progress bar */}
        <div className="mt-3 h-1.5 w-full rounded-full bg-border overflow-hidden">
          <div
            className="h-full rounded-full bg-accent transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        <div className="divide-y divide-border">
          {loop.workpackages.map((wp, idx) => {
            const config = statusConfig[wp.status];
            const Icon = config.icon;
            const isRunning = wp.status === 'running';
            const hasSession = Boolean(wp.sessionId);

            return (
              <div
                key={wp.id}
                className={cn(
                  'flex items-start gap-3 px-4 py-3',
                  isRunning && 'bg-accent/5',
                  hasSession && 'cursor-pointer hover:bg-interactive-hover',
                )}
                onClick={() => {
                  if (wp.sessionId) {
                    setCurrentSession(wp.sessionId);
                  }
                }}
                role={hasSession ? 'button' : undefined}
                tabIndex={hasSession ? 0 : undefined}
                onKeyDown={(e) => {
                  if (hasSession && wp.sessionId && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    setCurrentSession(wp.sessionId);
                  }
                }}
              >
                {/* Status icon */}
                <div className={cn('mt-0.5 shrink-0', config.color)}>
                  <Icon className={cn('h-4 w-4', isRunning && 'animate-spin')} />
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="typography-meta text-foreground-muted shrink-0">
                      {idx + 1}.
                    </span>
                    <span className={cn(
                      'typography-label truncate',
                      wp.status === 'completed' ? 'text-foreground-muted line-through' : 'text-foreground',
                    )}>
                      {wp.title}
                    </span>
                    <span className={cn('typography-meta shrink-0', config.color)}>
                      {config.label}
                    </span>
                  </div>
                  {wp.error && (
                    <p className="mt-1 typography-meta text-destructive truncate">
                      {wp.error}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

interface LoopControlsProps {
  loop: AgentLoopInstance;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onSkip: (id: string) => void;
  onStop: (id: string) => void;
}

const LoopControls: React.FC<LoopControlsProps> = ({
  loop,
  onPause,
  onResume,
  onSkip,
  onStop,
}) => {
  if (loop.status === 'completed' || loop.status === 'error') {
    return null;
  }

  return (
    <div className="flex items-center gap-1">
      {loop.status === 'running' && (
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onPause(loop.id)}
            aria-label="Pause loop"
          >
            <RiPauseLine className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onSkip(loop.id)}
            aria-label="Skip current task"
          >
            <RiSkipForwardLine className="h-4 w-4" />
          </Button>
        </>
      )}
      {loop.status === 'paused' && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onResume(loop.id)}
          aria-label="Resume loop"
        >
          <RiPlayLine className="h-4 w-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onStop(loop.id)}
        aria-label="Stop loop"
      >
        <RiStopLine className="h-4 w-4" />
      </Button>
    </div>
  );
};
