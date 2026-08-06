import React from 'react';
import { SessionStatusIndicator, type SessionDisplayStatusType } from '@/components/session/SessionStatusIndicator';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';

export type MobileSessionRowStatusProps = {
  statusType: SessionDisplayStatusType;
  showUnread: boolean;
  showActivityDuration: boolean;
  sessionId: string;
  isStreaming: boolean;
  time: string;
};

/**
 * Mobile session row status area: live-status indicator + elapsed-turn
 * readout or relative timestamp. Owned separately from the left gutter's
 * expand/collapse control so status presentation never overlaps or
 * replaces the child-toggle action.
 */
export function MobileSessionRowStatus({
  statusType,
  showUnread,
  showActivityDuration,
  sessionId,
  isStreaming,
  time,
}: MobileSessionRowStatusProps): React.ReactElement | null {
  return (
    <>
      <SessionStatusIndicator
        statusType={statusType}
        showUnread={showUnread}
        size="sm"
        className="flex h-3 w-3 flex-shrink-0 items-center justify-center"
      />
      {showActivityDuration ? (
        <SessionActivityDuration
          sessionId={sessionId}
          running={isStreaming}
          className="typography-micro"
        />
      ) : time ? (
        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{time}</span>
      ) : null}
    </>
  );
}