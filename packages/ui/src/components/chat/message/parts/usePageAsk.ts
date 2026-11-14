import type { RenderedPageAsk } from '@/lib/opencode/tools';
import type { ToolPart } from '@/lib/opencode/model';
import { useIsCallWaiting } from '@/sync/global-blocking-requests';
import { useSessionDirectory, useSessionStatus, useSessionStatusSnapshotReady } from '@/sync/sync-context';

/**
 * Where a page stands on the user's answer, given what is live. The stored
 * call only says that it runs, and it keeps saying so after the wait is gone:
 * OpenCode stopped under it (the app restarted) and nothing completed the
 * call. The server refuses an answer for such a page. So a running call that
 * the server does not announce as waiting, in a session that no longer runs,
 * was left unanswered. Until the session is known to be idle the stored call
 * stands: the announcement can still be on its way.
 */
export const livePageAsk = (ask: RenderedPageAsk, announced: boolean, sessionIdle: boolean): RenderedPageAsk => (
    ask.kind === 'waiting' && !announced && sessionIdle ? { kind: 'unanswered' } : ask
);

/** `livePageAsk` for a call's page. Only a call stored as waiting subscribes to anything. */
export function usePageAsk(part: ToolPart, ask: RenderedPageAsk | undefined): RenderedPageAsk | undefined {
    const sessionId = ask?.kind === 'waiting' ? part.sessionID : '';
    const directory = useSessionDirectory(sessionId);
    const announced = useIsCallWaiting(sessionId, part.callID);
    const status = useSessionStatus(sessionId, directory);
    // OpenCode lists only running sessions, so an omitted status is idle once the directory's snapshot has landed.
    const snapshotReady = useSessionStatusSnapshotReady(directory, sessionId);
    if (!ask) return undefined;
    return livePageAsk(ask, announced, status ? status.type === 'idle' : snapshotReady);
}
