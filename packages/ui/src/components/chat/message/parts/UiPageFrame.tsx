import React from 'react';
import { toast } from '@/components/ui';
import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import { answerRenderedPage } from '@/lib/renderPageAnswer';
import { pageAnswerSummary, uiBlockAnswerData, type UiBlockAnswer } from '../../uiBlocks/answer';
import type { UiBlockHost } from '../../uiBlocks/UiBlock';
import { useUiBlockComponent } from '../../uiBlocks/useUiBlockComponent';
import { DeclinePageButton } from './DeclinePageButton';
import { usePageDecline } from './usePageDecline';
import { useIsPageSettled } from '@/sync/global-blocking-requests';
import { PageAskStatus } from './PageAskStatus';

/**
 * A page an agent showed with `openchamber_render` as a `ui` program: drawn
 * with the chat's own components, like a UI block in a reply. While the call
 * waits, a Button answers it; a program this client cannot draw answers it
 * with the parser's errors instead, so the agent is not left waiting on
 * fields nobody can see.
 */
export function UiPageFrame({ part, source, ask }: { part: ToolPart; source: string; ask: RenderedPageAsk }) {
    const { t } = useI18n();
    const UiBlock = useUiBlockComponent();
    const [sentSummary, setSentSummary] = React.useState<string | null>(null);
    const { sessionID, callID } = part;
    // Shown until the call completes with the decline OpenCode stores.
    const [decline, sendDecline] = usePageDecline(sessionID, callID);
    const settled = useIsPageSettled(sessionID, callID);
    const waiting = ask.kind === 'waiting' && sentSummary === null && decline !== 'declined' && !settled;

    const submit = React.useCallback(async (answer: UiBlockAnswer) => {
        const summary = pageAnswerSummary(answer.summary);
        try {
            await answerRenderedPage({ sessionId: sessionID, callId: callID, summary, data: answer.data });
            setSentSummary(summary);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.htmlRender.answerFailed'), { description: message });
            throw error;
        }
    }, [callID, sessionID, t]);

    const host = React.useMemo<UiBlockHost>(() => {
        const answered = ask.kind === 'answered' ? uiBlockAnswerData.safeParse(ask.data) : null;
        return {
            kind: 'page',
            submit: waiting && decline === 'idle' ? submit : null,
            answered: answered?.success ? answered.data : null,
        };
    }, [ask, waiting, decline, submit]);

    const reported = React.useRef(false);
    const reportNotDrawn = React.useCallback((errors: string[]) => {
        if (!waiting || reported.current) return;
        reported.current = true;
        // Another client may have reported it first; the page then no longer waits.
        void answerRenderedPage({ sessionId: sessionID, callId: callID, notDrawn: errors }).catch(() => {});
    }, [waiting, sessionID, callID]);

    // The chat brings a page that waits for an answer into view.
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (waiting) dispatchPageWaiting(blockRef.current);
    }, [waiting]);

    return (
        <div ref={blockRef} className="my-2" data-ui-render-part={part.id} data-ui-render-message={part.messageID} data-waiting-page={waiting ? part.id : undefined}>
            {UiBlock
                ? (
                    <UiBlock
                        source={source}
                        complete
                        host={host}
                        onNotDrawn={reportNotDrawn}
                        actions={waiting ? <DeclinePageButton onDecline={sendDecline} disabled={decline === 'sending'} /> : null}
                    />
                )
                : <pre dir="ltr" data-chat-quote-pending="true"><code>{source}</code></pre>}
            <PageAskStatus
                ask={decline === 'declined' && ask.kind === 'waiting' ? { kind: 'declined' } : ask}
                answeredSummary={ask.kind === 'answered' ? ask.summary : sentSummary ?? undefined}
            />
        </div>
    );
}
