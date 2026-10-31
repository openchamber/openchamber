import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import { cn } from '@/lib/utils';

// Its own component: the blink re-renders this dot once a second, not the page around it.
function WaitingDot() {
    const blink = useWaitingBlink(true);
    return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full bg-[var(--primary-base)]', blink)} />;
}

/** The line under a page an agent showed: whether it waits, and how it was answered. */
export function PageAskStatus({ ask, answeredSummary }: { ask: RenderedPageAsk; answeredSummary: string | undefined }) {
    const { t } = useI18n();
    const status = answeredSummary !== undefined
        // A form's summary has a line per field; on one line they need a separator.
        ? t('chat.htmlRender.answered', { summary: answeredSummary.trim().replace(/\s*\n\s*/g, ' · ') })
        : ask.kind === 'waiting'
            ? t('chat.htmlRender.waiting')
            : ask.kind === 'answered-in-chat'
                ? t('chat.htmlRender.answeredInChat')
                : ask.kind === 'chat-sent-earlier'
                    ? t('chat.htmlRender.chatSentEarlier')
                    : ask.kind === 'unanswered' ? t('chat.htmlRender.unanswered') : null;
    if (!status) return null;
    const waiting = ask.kind === 'waiting' && answeredSummary === undefined;
    return (
        <div className="mt-1 flex items-center gap-1.5 typography-meta text-muted-foreground" data-html-render-status={ask.kind}>
            {waiting ? <WaitingDot /> : null}
            <span className="min-w-0 truncate" title={status}>{status}</span>
        </div>
    );
}
