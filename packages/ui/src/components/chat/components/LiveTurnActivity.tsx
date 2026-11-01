import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import {
    ActivityRowSkipContext,
    LIVE_ACTIVITY_VISIBLE_ROWS,
    activityRowParts,
    planActivityTrim,
} from '../lib/turns/activityRows';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { getShownPages } from '../lib/turns/liveActivity';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { ShownToolCard } from '../message/parts/ShownToolCard';
import { useActivityRowGlide } from './useActivityRowGlide';
import { foldContentId, finalActivityContentId, useTurnFold } from './useTurnFold';
import { dispatchRowExpand } from '../lib/scroll/timelineScrollIntent';

interface TurnFoldProps {
    turn: TurnRecord;
    hasLaterAssistant: boolean;
    expanded: boolean;
    finalMessageId: string | undefined;
    onToggle: () => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

/**
 * The fold's header. Folded, it also draws what stays in view: a working
 * turn's latest steps before the pages it showed.
 */
export function TurnFold({ turn, hasLaterAssistant, expanded, finalMessageId, onToggle, renderMessage }: TurnFoldProps) {
    const { t } = useI18n();
    const { finalMessage, activityMessages, settled, isExpanded, pages } = useTurnFold(turn, hasLaterAssistant, expanded, finalMessageId);
    // Folded, a working turn shows only its latest rows (the header counts
    // the earlier ones) and a settled one shows none.
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const trim = React.useMemo(() => (expanded
        ? null
        : planActivityTrim(
            activityMessages.map((message) => activityRowParts(message.parts, showReasoningTraces).length),
            LIVE_ACTIVITY_VISIBLE_ROWS,
        )), [activityMessages, expanded, showReasoningTraces]);
    const shownMessages = React.useMemo(
        () => (trim && trim.hiddenMessages > 0 ? activityMessages.slice(trim.hiddenMessages) : activityMessages),
        [activityMessages, trim],
    );
    const skippedMessageId = trim && trim.skipRows > 0 ? shownMessages[0]?.info.id : undefined;
    const skippedRows = trim?.skipRows ?? 0;
    const rowSkip = React.useMemo(
        () => (skippedMessageId ? { messageId: skippedMessageId, rows: skippedRows } : null),
        [skippedMessageId, skippedRows],
    );
    const hiddenRows = trim?.hiddenRows ?? 0;
    const rowsRef = React.useRef<HTMLDivElement>(null);
    useActivityRowGlide(rowsRef, hiddenRows, !settled && !expanded);
    // While the turn works, what the agent does after its last page (more
    // steps, the reply it is still writing) is drawn below the page, in the
    // order it happened.
    const lastPageMessageId = !finalMessage && pages.length > 0 ? pages[pages.length - 1]?.messageID : undefined;
    const messagesAbovePages = React.useMemo(() => {
        const pageIndex = lastPageMessageId ? activityMessages.findIndex((message) => message.info.id === lastPageMessageId) : -1;
        if (pageIndex < 0) return shownMessages;
        // The fold shows the tail of the turn, so the page's message may
        // already be trimmed away; everything still shown then came after it.
        const split = Math.max(0, pageIndex + 1 - (activityMessages.length - shownMessages.length));
        return shownMessages.slice(0, split);
    }, [activityMessages, lastPageMessageId, shownMessages]);
    // No diff parsing at token frequency. The report is only shown once the
    // turn settles; later authoritative tool metadata can refine it.
    const summary = React.useMemo(() => settled ? summarizeLiveActivity(turn.assistantMessages) : null,
        [settled, turn.assistantMessages]);
    const fileLabel = summary && summary.files > 0
        ? t(summary.files === 1 ? 'chat.liveActivity.changedFile' : 'chat.liveActivity.changedFiles', { count: summary.files })
        : null;
    const details = summary ? [
        summary.explored ? t('chat.liveActivity.explored') : null,
        summary.commands > 0 ? t(summary.commands === 1 ? 'chat.liveActivity.ranCommand' : 'chat.liveActivity.ranCommands', { count: summary.commands }) : null,
        summary.researched ? t('chat.liveActivity.researched') : null,
        summary.subagents > 0 ? t(summary.subagents === 1 ? 'chat.liveActivity.usedSubagent' : 'chat.liveActivity.usedSubagents', { count: summary.subagents }) : null,
    ].filter(Boolean).join(' · ') : '';
    const label = (
        <>
            <Icon name="stack" className="size-3.5 shrink-0 text-[var(--tools-icon)]" />
            <span className="shrink-0 font-semibold text-[var(--tools-title)]">{t('chat.liveActivity.title')}</span>
            <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0" />
            {fileLabel ? (
                <span className="flex min-w-0 items-center gap-1 typography-meta @min-[560px]:shrink-0">
                    <span className="truncate">{fileLabel}</span>
                    {summary?.hasCompleteDiff && (summary.additions > 0 || summary.deletions > 0) ? (
                        <span className="shrink-0 tabular-nums">
                            <span className="text-[var(--status-success)]">+{summary.additions}</span>
                            <span aria-hidden="true">/</span>
                            <span className="text-[var(--status-error)]">-{summary.deletions}</span>
                        </span>
                    ) : null}
                </span>
            ) : null}
            {details ? <span className="hidden min-w-0 flex-1 truncate text-start typography-meta @min-[560px]:inline" title={details}>{fileLabel ? '· ' : ''}{details}</span> : null}
            {!settled && hiddenRows > 0 ? (
                <span className="shrink-0 typography-meta">{t('chat.liveActivity.moreRows', { count: hiddenRows })}</span>
            ) : null}
        </>
    );
    // The fold opens below its header, which stays where the reader clicked it.
    const handleToggle = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (!expanded) dispatchRowExpand(event.currentTarget);
        onToggle();
    }, [expanded, onToggle]);
    const headerClass = 'w-full justify-start normal-case !ps-px !pe-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    const contentId = foldContentId(turn.turnId);
    return (
        <div className="relative z-0" data-live-turn-activity={turn.turnId}>
            <div className="chat-message-column @container">
                <div className="mt-1">
                    <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle}
                        aria-expanded={expanded} aria-controls={finalMessage ? `${contentId} ${finalActivityContentId(turn.turnId)}` : contentId}>
                        {label}
                    </Button>
                </div>
            </div>
            {expanded ? null : (
                <>
                    <LiveActivityCollapse expanded={isExpanded} id={contentId}>
                        <div ref={rowsRef}>
                            <ActivityRowSkipContext.Provider value={rowSkip}>
                                {messagesAbovePages.map((message) => (
                                    <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>
                                ))}
                            </ActivityRowSkipContext.Provider>
                        </div>
                    </LiveActivityCollapse>
                </>
            )}
        </div>
    );
}

/** The pages a turn's agent showed, while the turn has no answer to draw them above. */
function TurnPages({ pages }: { pages: ReturnType<typeof getShownPages> }) {
    return (
        <div className="chat-message-column">
            {pages.map((part) => <ShownToolCard key={part.id} part={part} />)}
        </div>
    );
}

/** A stable pages row, with the closed live preview that follows it. */
export function TurnPagesRow({ turn, hasLaterAssistant, expanded, renderMessage }: Pick<TurnFoldProps, 'turn' | 'hasLaterAssistant' | 'expanded' | 'renderMessage'>) {
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages), [turn.assistantMessages]);
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    if (pages.length === 0) return null;
    const lastPageMessageId = pages[pages.length - 1]?.messageID;
    const pageIndex = turn.assistantMessages.findIndex((message) => message.info.id === lastPageMessageId);
    const trim = planActivityTrim(turn.assistantMessages.map((message) => activityRowParts(message.parts, showReasoningTraces).length), LIVE_ACTIVITY_VISIBLE_ROWS);
    const shown = turn.assistantMessages.slice(trim.hiddenMessages);
    const split = pageIndex < 0 ? shown.length : Math.max(0, pageIndex + 1 - trim.hiddenMessages);
    const rowSkip = trim.skipRows > 0 && shown[0] ? { messageId: shown[0].info.id, rows: trim.skipRows } : null;
    return <>
        <TurnPages pages={pages} />
        {!expanded && !hasLaterAssistant ? <ActivityRowSkipContext.Provider value={rowSkip}>
            {shown.slice(split).map((message) => <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>)}
        </ActivityRowSkipContext.Provider> : null}
    </>;
}
