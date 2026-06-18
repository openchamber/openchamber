import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { useSessionMessageRecords, useEnsureSessionMessages } from '@/sync/sync-context';
import { useDurationTickerNow } from './useDurationTicker';

type SubagentProgressIndicatorProps = {
  taskSessionId: string;
  currentDirectory: string;
  className?: string;
};

const countToolParts = (messages: Array<{ parts?: unknown[] }> | undefined | null) => {
  if (!Array.isArray(messages)) return { completed: 0, inFlight: 0, total: 0 };

  let completed = 0;
  let inFlight = 0;

  for (const message of messages) {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const rawPart of parts) {
      const part = rawPart as { type?: string; state?: { status?: string } } | undefined;
      if (part?.type !== 'tool') continue;
      const status = part.state?.status;
      const isFinalized =
        status === 'completed' || status === 'error' || status === 'failed' || status === 'aborted' || status === 'timeout' || status === 'cancelled';
      if (isFinalized) {
        completed += 1;
      } else {
        inFlight += 1;
      }
    }
  }

  return { completed, inFlight, total: completed + inFlight };
};

export const SubagentProgressIndicator: React.FC<SubagentProgressIndicatorProps> = ({
  taskSessionId,
  currentDirectory,
  className,
}) => {
  const childSessionMessages = useSessionMessageRecords(taskSessionId, currentDirectory);
  useEnsureSessionMessages(taskSessionId, currentDirectory);
  const childSessionActivity = useSessionActivity(taskSessionId, currentDirectory);

  const firstMessage = Array.isArray(childSessionMessages) ? childSessionMessages[0] : undefined;
  const startTime = (firstMessage as { time?: { created?: number } } | undefined)?.time?.created;
  const hasStartTime = typeof startTime === 'number' && Number.isFinite(startTime);

  const isActive =
    childSessionActivity.isWorking || childSessionActivity.phase === 'busy' || childSessionActivity.phase === 'retry';

  const now = useDurationTickerNow(isActive, 1000);
  const elapsedMs = hasStartTime && isActive ? Math.max(0, now - startTime) : 0;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  const { completed, inFlight } = countToolParts(childSessionMessages);

  if (!isActive && inFlight === 0) {
    return null;
  }

  const phaseLabel = childSessionActivity.phase === 'retry' ? 'Retrying' : 'Running';

  return (
    <div className={cn('flex items-center gap-2 typography-meta text-muted-foreground', className)}>
      <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
      <span className="tabular-nums">{`${phaseLabel} ${elapsedSeconds}s`}</span>
      {completed > 0 || inFlight > 0 ? (
        <span className="text-muted-foreground/70">{`${completed} done · ${inFlight} active`}</span>
      ) : null}
    </div>
  );
};

SubagentProgressIndicator.displayName = 'SubagentProgressIndicator';
