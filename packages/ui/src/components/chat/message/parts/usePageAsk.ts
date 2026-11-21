import type { RenderedPageAsk } from '@/lib/opencode/tools';
import type { ToolPart } from '@/lib/opencode/model';
import { useIsCallWaiting } from '@/sync/global-blocking-requests';
import { useLaterPage, type LaterPage } from '@/sync/later-pages';
import { useSessionDirectory, useSessionStatus, useSessionStatusSnapshotReady } from '@/sync/sync-context';

export const livePageAsk = (ask: RenderedPageAsk, announced: boolean, sessionIdle: boolean): RenderedPageAsk => (
    ask.kind === 'waiting' && !announced && sessionIdle ? { kind: 'unanswered' } : ask
);

export const laterPageAsk = (page: LaterPage | undefined): RenderedPageAsk => {
    if (page?.status === 'open') return { kind: 'waiting', later: true };
    const undelivered = page?.undelivered ? { undelivered: true as const } : {};
    if (page?.status === 'answered') return { kind: 'answered', summary: page.summary ?? '', data: page.data ?? null, ...undelivered };
    if (page?.status === 'declined') return { kind: 'declined', ...undelivered };
    if (page?.status === 'ui-not-drawn') return { kind: 'not-drawn', ...undelivered };
    return { kind: 'show' };
};

export const pageBlocksTurn = (ask: RenderedPageAsk): boolean => ask.kind === 'waiting' && ask.later !== true;

export function usePageAsk(part: ToolPart, ask: RenderedPageAsk | undefined): RenderedPageAsk | undefined {
    const laterPage = useLaterPage(ask?.kind === 'later' ? part.sessionID : '', part.callID);
    const sessionId = ask?.kind === 'waiting' ? part.sessionID : '';
    const directory = useSessionDirectory(sessionId);
    const announced = useIsCallWaiting(sessionId, part.callID);
    const status = useSessionStatus(sessionId, directory);
    const snapshotReady = useSessionStatusSnapshotReady(directory, sessionId);
    if (!ask) return undefined;
    if (ask.kind === 'later') return laterPageAsk(laterPage);
    return livePageAsk(ask, announced, status ? status.type === 'idle' : snapshotReady);
}
