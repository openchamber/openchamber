import React from 'react';
import { useSession, useSessionStatus } from '@/sync/sync-context';
import { getCurrentSessionAssist, type SessionAssistPayload } from '@/lib/sessionAssistMetadata';
import { useUIStore } from '@/stores/useUIStore';

const RECAP_VISIBILITY_DELAY_MS = 60 * 1000;

export interface SessionAssistState {
  assist: SessionAssistPayload | null;
  visibleRecap: string | null;
  suggestion: string | null;
  sessionKnown: boolean;
}

export function useSessionAssistState(sessionId: string, directory?: string): SessionAssistState {
  const session = useSession(sessionId, directory);
  const status = useSessionStatus(sessionId, directory);
  const sessionRecapEnabled = useUIStore((state) => state.sessionRecapEnabled);
  const sessionSuggestionEnabled = useUIStore((state) => state.sessionSuggestionEnabled);

  const isIdle = !status || status.type === 'idle';
  const assist = isIdle ? getCurrentSessionAssist(session) : null;

  const idleAt = session?.time?.idle ?? 0;
  const [, forceTick] = React.useReducer((tick: number) => tick + 1, 0);
  const quietElapsed = assist ? Date.now() - idleAt >= RECAP_VISIBILITY_DELAY_MS : false;

  React.useEffect(() => {
    if (!assist || quietElapsed || !idleAt) return undefined;
    const remaining = RECAP_VISIBILITY_DELAY_MS - (Date.now() - idleAt);
    if (remaining <= 0) return undefined;
    const timer = setTimeout(forceTick, remaining + 250);
    return () => clearTimeout(timer);
  }, [assist, quietElapsed, idleAt]);

  return {
    assist,
    visibleRecap: sessionRecapEnabled && assist && assist.recap && quietElapsed ? assist.recap : null,
    suggestion: sessionSuggestionEnabled && assist && assist.suggestion ? assist.suggestion : null,
    sessionKnown: session !== undefined && session !== null,
  };
}
