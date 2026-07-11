import React from 'react';
import { useDaytonaSandboxStore } from '@/stores/useDaytonaSandboxStore';
import { cn } from '@/lib/utils';

interface SandboxStatusIndicatorProps {
  sessionId: string | null | undefined;
  className?: string;
}

const statusConfig: Record<string, { dotColor: string; label: string }> = {
  creating: { dotColor: 'bg-yellow-400', label: 'Creating...' },
  running: { dotColor: 'bg-green-500', label: 'Sandbox Active' },
  stopping: { dotColor: 'bg-orange-400', label: 'Stopping...' },
  destroyed: { dotColor: 'bg-neutral-400', label: 'Destroyed' },
  error: { dotColor: 'bg-red-500', label: 'Error' },
  'timed-out': { dotColor: 'bg-red-400', label: 'Timed Out' },
};

export const SandboxStatusIndicator: React.FC<SandboxStatusIndicatorProps> = React.memo(
  ({ sessionId, className }) => {
    const sandboxMode = useDaytonaSandboxStore((state) => state.sandboxMode);
    const sandbox = useDaytonaSandboxStore((state) =>
      sessionId ? state.sandboxes.get(sessionId) : undefined,
    );

    if (!sandboxMode || !sandbox) return null;

    const config = statusConfig[sandbox.status] ?? statusConfig.error;

    return (
      <div className={cn('flex items-center gap-1.5', className)}>
        <span
          className={cn('inline-block h-2 w-2 rounded-full', config.dotColor)}
          aria-hidden="true"
        />
        <span className="typography-meta text-muted-foreground">
          {config.label}
        </span>
      </div>
    );
  },
);

SandboxStatusIndicator.displayName = 'SandboxStatusIndicator';
