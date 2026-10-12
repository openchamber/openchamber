import type { SessionActivityResult } from '@/hooks/useSessionActivity';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';
import { hasActiveSubagent, useGlobalSessionStatusStore } from '@/sync/global-session-status';

export function useComposerFollowUpActivity(
  sessionId: string | null,
  phase: SessionActivityResult['phase'],
  autoReviewRunning: boolean,
  followUpBehavior: FollowUpBehavior,
  hasPendingForm: boolean,
): boolean {
  const subagentRunning = useGlobalSessionStatusStore((state) => (
    followUpBehavior === 'queue' && !hasPendingForm && phase === 'idle' && sessionId !== null
      && hasActiveSubagent(sessionId, state.activeSessionIds)
  ));
  return phase !== 'idle' || autoReviewRunning || subagentRunning;
}
