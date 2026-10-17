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
import { getLiveFinalMessage, getShownPages } from '../lib/turns/liveActivity';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { LiveFinalActivityContext, LiveTurnHoistedPagesContext } from './liveActivityContext';
import { ShownPage } from '../message/parts/HtmlRenderFrame';
import { TurnMessageWindow } from './TurnMessageWindow';
import { useActivityRowGlide } from './useActivityRowGlide';
import { TurnMessageWindowContext, isReaderAtTimelineEnd, openedFoldMessageWindow } from '../lib/turns/turnMessageWindow';

const NO_MESSAGES: ChatMessageEntry[] = [];

interface LiveTurnActivityProps {
    turn: TurnRecord;
    hasLaterAssistant: boolean;
    expanded: boolean;
    onToggle: () => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

export function LiveTurnActivity({ turn, hasLaterAssistant, expanded, onToggle, renderMessage }: LiveTurnActivityProps) {
    const { t } = useI18n();
    const contentId = React.useId();
    const finalContentId = React.useId();
    const finalMessage = getLiveFinalMessage(turn.assistantMessages);
    const activityMessages = React.useMemo(
        () => (finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages),
        [finalMessage, turn.assistantMessages],
    );
    const settled = Boolean(finalMessage) || hasLaterAssistant;
    const isExpanded = !settled || expanded;
    // One toggle for the whole turn. Folded, a working turn shows only its
    // latest rows (the header counts the earlier ones) and a settled one shows
    // none; opened, both show every row. The trim also stays while a settled
    // fold closes, so its content does not change under the animation.
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const trimRows = !expanded;
    const trim = React.useMemo(() => (trimRows
        ? planActivityTrim(
            activityMessages.map((message) => activityRowParts(message.parts, showReasoningTraces).length),
            LIVE_ACTIVITY_VISIBLE_ROWS,
        )
        : null), [activityMessages, showReasoningTraces, trimRows]);
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
    const previouslySettled = React.useRef(settled);
    const animateFinalCollapse = settled && !previouslySettled.current;
    React.useLayoutEffect(() => { previouslySettled.current = settled; }, [settled]);
    // A page the agent showed is never folded away: it sits below the fold,
    // above the answer once one arrives, and stays there in a turn that ended
    // without one. The fold no longer holds it, so it moves at most from the
    // bottom of the fold to the top of the answer.
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages), [turn.assistantMessages]);
    // While the turn works, what the agent does after its last page (more
    // steps, the reply it is still writing) is drawn below the page, in the
    // order it happened; drawn inside the fold, it sat above the page until
    // the answer was marked final, and the page then jumped over it. Once the
    // answer arrives everything but the answer folds away as before.
    const lastPageMessageId = !finalMessage && pages.length > 0 ? pages[pages.length - 1]?.messageID : undefined;
    const [messagesAbovePages, messagesBelowPages] = React.useMemo(() => {
        const pageIndex = lastPageMessageId ? activityMessages.findIndex((message) => message.info.id === lastPageMessageId) : -1;
        if (pageIndex < 0) return [shownMessages, NO_MESSAGES];
        // The fold shows the tail of the turn, so the page's message may
        // already be trimmed away; everything still shown then came after it.
        const split = Math.max(0, pageIndex + 1 - (activityMessages.length - shownMessages.length));
        return [shownMessages.slice(0, split), shownMessages.slice(split)];
    }, [activityMessages, lastPageMessageId, shownMessages]);
    const hoistedPages = React.useMemo(() => new Set(pages.map((part) => part.id)), [pages]);
    const finalContext = React.useMemo(() => finalMessage ? {
        messageId: finalMessage.info.id, expanded: isExpanded, contentId: finalContentId, animateCollapse: animateFinalCollapse, pages,
    } : null, [finalMessage, isExpanded, finalContentId, animateFinalCollapse, pages]);
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
    const windowStore = React.useContext(TurnMessageWindowContext);
    // Opening the fold mounts the end of it that stays on screen (see
    // openedFoldMessageWindow), so a very long turn opens at once.
    const handleToggle = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (!expanded && windowStore) {
            windowStore.setRange(turn.turnId, openedFoldMessageWindow(activityMessages.length, isReaderAtTimelineEnd(event.currentTarget)));
        }
        onToggle();
    }, [activityMessages.length, expanded, onToggle, turn.turnId, windowStore]);
    const headerClass = 'w-full justify-start normal-case !ps-px !pe-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    return (
        <LiveTurnHoistedPagesContext.Provider value={hoistedPages}>
            <div className="relative z-0" data-live-turn-activity={turn.turnId}>
                <div className="chat-message-column @container">
                    <div className="mt-1">
                        <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle}
                            aria-expanded={expanded} aria-controls={finalMessage ? `${contentId} ${finalContentId}` : contentId}>
                            {label}
                        </Button>
                    </div>
                </div>
                <LiveActivityCollapse expanded={isExpanded} id={contentId}>
                    <div ref={rowsRef}>
                        <ActivityRowSkipContext.Provider value={rowSkip}>
                            <TurnMessageWindow turnId={turn.turnId} messages={messagesAbovePages} renderMessage={renderMessage} />
                        </ActivityRowSkipContext.Provider>
                    </div>
                </LiveActivityCollapse>
                {!finalMessage && pages.length > 0 ? (
                    <div className="chat-message-column">
                        {pages.map((part) => <ShownPage key={part.id} part={part} />)}
                    </div>
                ) : null}
                {messagesBelowPages.length > 0 ? (
                    <ActivityRowSkipContext.Provider value={rowSkip}>
                        {messagesBelowPages.map((message) => (
                            <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>
                        ))}
                    </ActivityRowSkipContext.Provider>
                ) : null}
                <LiveFinalActivityContext.Provider value={finalContext}>
                    {finalMessage ? renderMessage(finalMessage) : null}
                </LiveFinalActivityContext.Provider>
            </div>
        </LiveTurnHoistedPagesContext.Provider>
    );
}
