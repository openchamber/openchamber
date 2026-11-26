import React from 'react';
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
import { FoldLine } from './FoldLine';
import { NestedRow } from './NestedRow';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { ShownPartCard } from '../message/parts/ShownToolCard';
import { useActivityRowGlide, useLiveRowsFloor } from './useActivityRowGlide';
import { foldContentId, finalActivityContentId, useTurnFold } from './useTurnFold';
import { LiveActivityInteractionContext } from './liveActivityContext';
import { renderedPage } from '@/lib/opencode/tools';
import type { ShownPart } from '../lib/turns/liveActivity';
import { DiffCount } from '@/components/ui/diff-count';

const NO_MESSAGES: ChatMessageEntry[] = [];


interface TurnFoldProps {
    turn: TurnRecord;
    hasLaterAssistant: boolean;
    expanded: boolean;
    finalMessageId: string | undefined;
    onToggle: () => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

export function TurnFold({ turn, hasLaterAssistant, expanded, finalMessageId, onToggle, renderMessage }: TurnFoldProps) {
    const { t } = useI18n();
    const { finalMessage, activityMessages, settled, isExpanded: autoExpanded, pages } = useTurnFold(turn, hasLaterAssistant, expanded, finalMessageId);
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const [interactionHolds, setInteractionHolds] = React.useState(0);
    const pagesShown = !finalMessage && pages.length > 0;
    const hold = React.useCallback(() => setInteractionHolds((count) => count + 1), []);
    const release = React.useCallback(() => setInteractionHolds((count) => Math.max(0, count - 1)), []);
    const interaction = React.useMemo(() => ({ hold, release, pagesShown }), [hold, release, pagesShown]);
    const held = interactionHolds > 0;
    const isExpanded = held || autoExpanded;
    const liveTrim = React.useMemo(() => {
        if (expanded) return null;
        const shownBelow = new Set(pages.map((part) => part.id));
        return planActivityTrim(
            activityMessages.map((message) => activityRowParts(message.parts, showReasoningTraces).filter((part) => !shownBelow.has(part.id)).length),
            LIVE_ACTIVITY_VISIBLE_ROWS,
        );
    }, [activityMessages, expanded, pages, showReasoningTraces]);
    const trimRef = React.useRef(liveTrim);
    if (!held) trimRef.current = liveTrim;
    const trim = held && !expanded ? trimRef.current : liveTrim;
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
    const previewFloorRef = React.useRef<HTMLDivElement>(null);
    const previewRef = React.useRef<HTMLDivElement>(null);
    useActivityRowGlide(rowsRef, hiddenRows, !settled && !expanded);
    useLiveRowsFloor(previewFloorRef, previewRef, !expanded && (held || !settled));
    const livePageMessageId = React.useMemo(() => {
        if (finalMessage) return undefined;
        return pages.at(-1)?.messageID;
    }, [finalMessage, pages]);
    const pageMessageIdRef = React.useRef(livePageMessageId);
    if (!held) pageMessageIdRef.current = livePageMessageId;
    const lastPageMessageId = held ? pageMessageIdRef.current : livePageMessageId;
    const [messagesAbovePages, messagesBelowPages] = React.useMemo(() => {
        const pageIndex = lastPageMessageId ? activityMessages.findIndex((message) => message.info.id === lastPageMessageId) : -1;
        if (pageIndex < 0) return [shownMessages, NO_MESSAGES];
        const split = Math.max(0, pageIndex + 1 - (activityMessages.length - shownMessages.length));
        return [shownMessages.slice(0, split), shownMessages.slice(split)];
    }, [activityMessages, lastPageMessageId, shownMessages]);
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
    ].filter((detail) => detail !== null) : [];
    const rest = (fileLabel ? details : details.slice(1)).join(' · ');
    const label = fileLabel || details.length > 0 ? (
        <>
            {fileLabel ? (
                <span className="flex shrink-0 items-center gap-1 text-[var(--tools-title)]">
                    {fileLabel}
                    {summary?.hasCompleteDiff && (summary.additions > 0 || summary.deletions > 0) ? (
                        <DiffCount added={summary.additions} removed={summary.deletions} />
                    ) : null}
                </span>
            ) : <span className="shrink-0 text-[var(--tools-title)]">{details[0]}</span>}
            <span className="min-w-0 truncate" title={rest}>{rest ? `· ${rest}` : null}</span>
        </>
    ) : (
        <>
            <span className="shrink-0 text-[var(--tools-title)]">{t('chat.liveActivity.title')}</span>
            {!settled && hiddenRows > 0 ? <span className="shrink-0">{t('chat.liveActivity.moreRows', { count: hiddenRows })}</span> : null}
        </>
    );
    const contentId = foldContentId(turn.turnId);
    return (
        <div className="relative z-0" data-live-turn-activity={turn.turnId}>
            <FoldLine icon="stack" open={expanded} controls={finalMessage ? `${contentId} ${finalActivityContentId(turn.turnId)}` : contentId} onToggle={onToggle}>
                {label}
            </FoldLine>
            {expanded ? null : (
                <LiveActivityInteractionContext.Provider value={interaction}>
                    <div ref={previewFloorRef}>
                        <div ref={previewRef}>
                            <LiveActivityCollapse expanded={isExpanded} id={contentId}>
                                <NestedRow depth={1}><div ref={rowsRef}>
                                    <ActivityRowSkipContext.Provider value={rowSkip}>
                                        {messagesAbovePages.map((message) => (
                                            <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>
                                        ))}
                                    </ActivityRowSkipContext.Provider>
                                </div></NestedRow>
                            </LiveActivityCollapse>
                            {pagesShown ? <TurnPages pages={pages} /> : null}
                            {messagesBelowPages.length > 0 ? (
                                <NestedRow depth={1}>
                                    <ActivityRowSkipContext.Provider value={rowSkip}>
                                        {messagesBelowPages.map((message) => (
                                            <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>
                                        ))}
                                    </ActivityRowSkipContext.Provider>
                                </NestedRow>
                            ) : null}
                        </div>
                    </div>
                </LiveActivityInteractionContext.Provider>
            )}
        </div>
    );
}

function TurnPages({ pages }: { pages: ReturnType<typeof getShownPages> }) {
    return (
        <div className="chat-message-column">
            {pages.map((part) => <TurnPage key={part.id} part={part} />)}
        </div>
    );
}

function TurnPage({ part }: { part: ShownPart }) {
    const page = part.type === 'tool' ? renderedPage(part.tool, part.state) : null;
    if (!page?.ui || page.ask.kind !== 'show') return <ShownPartCard part={part} />;
    return (
        <div data-ui-render-hoisted="true">
            <ShownPartCard part={part} />
        </div>
    );
}

export function TurnPagesRow({ turn }: { turn: TurnRecord }) {
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages), [turn.assistantMessages]);
    return pages.length > 0 ? <TurnPages pages={pages} /> : null;
}
