import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSessionWork } from '@/lib/sessionWorkMetadata';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { setSessionWorkState } from '@/sync/session-actions';

// Opens this client already tried to close, by runtime, session and the time
// the work opened: each open is closed once, so a write the server refuses is
// one request, not one per render, while a later open is closed again.
const attempted = new Set<string>();

/**
 * A pinned work is never in work. Pinning a session closes its work in the
 * same write, and the server opens no work in a pinned session or worktree;
 * what is still open here was left by an older build, a pin of a worktree
 * (which lives in git, apart from session state) or another client. The
 * sidebar closes it once it sees it, which also moves pins from before this
 * rule out of In work on the first load.
 */
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
