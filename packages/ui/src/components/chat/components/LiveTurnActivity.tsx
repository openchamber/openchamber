import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { getLiveFinalMessage } from '../lib/turns/liveActivity';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { LiveFinalActivityContext } from './liveActivityContext';

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
    const settled = Boolean(finalMessage) || hasLaterAssistant;
    const isExpanded = !settled || expanded;
    const previouslySettled = React.useRef(settled);
    const animateFinalCollapse = settled && !previouslySettled.current;
    React.useLayoutEffect(() => { previouslySettled.current = settled; }, [settled]);
    const finalContext = React.useMemo(() => finalMessage ? {
        messageId: finalMessage.info.id, expanded: isExpanded, contentId: finalContentId, animateCollapse: animateFinalCollapse,
    } : null, [finalMessage, isExpanded, finalContentId, animateFinalCollapse]);
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
            {settled ? <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0" /> : null}
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
            {details ? <span className="hidden min-w-0 flex-1 truncate text-left typography-meta @min-[560px]:inline" title={details}>{fileLabel ? '· ' : ''}{details}</span> : null}
        </>
    );
    const headerClass = 'w-full justify-start normal-case !pl-px !pr-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    return (
        <div className="relative z-0" data-live-turn-activity={turn.turnId}>
            {settled ? (
                <div className="chat-message-column @container">
                    <div className="mt-1 mb-2">
                        <Button variant="ghost" size="sm" className={headerClass} onClick={onToggle}
                            aria-expanded={isExpanded} aria-controls={finalMessage ? `${contentId} ${finalContentId}` : contentId}>
                            {label}
                        </Button>
                    </div>
                </div>
            ) : null}
            <LiveActivityCollapse expanded={isExpanded} id={contentId}>
                {turn.assistantMessages.map((message) => message === finalMessage ? null : renderMessage(message))}
            </LiveActivityCollapse>
            <LiveFinalActivityContext.Provider value={finalContext}>
                {finalMessage ? renderMessage(finalMessage) : null}
            </LiveFinalActivityContext.Provider>
        </div>
    );
}
