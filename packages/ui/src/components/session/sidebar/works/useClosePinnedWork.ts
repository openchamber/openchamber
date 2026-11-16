import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSessionWork } from '@/lib/sessionWorkMetadata';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { setSessionWorkState } from '@/sync/session-actions';

const attempted = new Set<string>();

export function useClosePinnedWork(sessions: readonly Session[]): void {
  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    for (const session of sessions) {
      const key = JSON.stringify([runtimeKey, session.id, getSessionWork(session)?.openedAt ?? null]);
      if (attempted.has(key)) continue;
      attempted.add(key);
      void setSessionWorkState(session.id, resolveGlobalSessionDirectory(session) ?? session.directory, 'done')
        .catch((error) => console.warn('[session-work] could not close the work of a pinned session', error));
    }
  }, [sessions]);
}
