import type { RenderedPageAsk } from '@/lib/opencode/tools';
import type { ToolPart } from '@/lib/opencode/model';
import { useIsCallWaiting } from '@/sync/global-blocking-requests';
import { useLaterPage, type LaterPage } from '@/sync/later-pages';
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

/**
 * Where a page shown with answerLater stands, as the server keeps it: open
 * takes an answer like a waiting page, then the answer it took, marked while
 * the agent has not got it yet. A page the
 * server does not keep (not loaded yet, or gone) is shown without asking.
 */
export const laterPageAsk = (page: LaterPage | undefined): RenderedPageAsk => {
    if (page?.status === 'open') return { kind: 'waiting', later: true };
    const undelivered = page?.undelivered ? { undelivered: true as const } : {};
    if (page?.status === 'answered') return { kind: 'answered', summary: page.summary ?? '', data: page.data ?? null, ...undelivered };
    if (page?.status === 'declined') return { kind: 'declined', ...undelivered };
    if (page?.status === 'ui-not-drawn') return { kind: 'not-drawn', ...undelivered };
    return { kind: 'show' };
};

/**
 * Whether the turn waits on this page: what the chat brings into view and a
 * toast's "Open session" finds. A later page takes an answer too, but nothing
 * waits on it, so it never stands in for a page that does.
 */
export const pageBlocksTurn = (ask: RenderedPageAsk): boolean => ask.kind === 'waiting' && ask.later !== true;

/** `livePageAsk` for a call's page, `laterPageAsk` for one shown with answerLater. Only those subscribe to anything. */
export function usePageAsk(part: ToolPart, ask: RenderedPageAsk | undefined): RenderedPageAsk | undefined {
    const laterPage = useLaterPage(ask?.kind === 'later' ? part.sessionID : '', part.callID);
    const sessionId = ask?.kind === 'waiting' ? part.sessionID : '';
    const directory = useSessionDirectory(sessionId);
    const announced = useIsCallWaiting(sessionId, part.callID);
    const status = useSessionStatus(sessionId, directory);
    // OpenCode lists only running sessions, so an omitted status is idle once the directory's snapshot has landed.
    const snapshotReady = useSessionStatusSnapshotReady(directory, sessionId);
    if (!ask) return undefined;
    if (ask.kind === 'later') return laterPageAsk(laterPage);
    return livePageAsk(ask, announced, status ? status.type === 'idle' : snapshotReady);
}
