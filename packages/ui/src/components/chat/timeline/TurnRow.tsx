import React from 'react';

import { ActivityGroupLine } from '../components/ActivityGroupLine';
import { FoldLine } from '../components/FoldLine';
import { NestedRow } from '../components/NestedRow';
import { TurnLine } from '../components/TurnLine';
import { useI18n } from '@/lib/i18n';
import TurnItem from '../components/TurnItem';
import { TurnFold, TurnPagesRow } from '../components/LiveTurnActivity';
import { useTurnFoldContexts } from '../components/useTurnFold';
import { LiveFinalActivityContext, LiveTurnHoistedPagesContext, ShownPartStreamPhaseContext } from '../components/liveActivityContext';
import { MessageSliceContext } from '../message/messageSliceContext';
import { cn } from '@/lib/utils';
import type { RenderRow, ToggleTurnActivity, TurnEntry } from './types';
import { useTurnMessageRenderer, type TurnRendererInput } from './useTurnMessageRenderer';

type TurnRowProps = Omit<TurnRendererInput, 'turn' | 'isLastTurn' | 'nextEntryFirstMessage'> & {
    row: Exclude<RenderRow, { kind: 'ungrouped' }>;
    entry: TurnEntry;
    turnExpansion: Map<string, boolean>;
    onToggleTurnActivity: ToggleTurnActivity;
};

export const TurnRow = React.memo(({
    row,
    entry,
    turnExpansion,
    onToggleTurnActivity,
    ...rendererInput
}: TurnRowProps) => {
    const { t } = useI18n();
    const { turn } = entry;
    const { renderMessage, streamPhaseOf } = useTurnMessageRenderer({
        ...rendererInput,
        turn,
        isLastTurn: entry.isLastTurn,
        nextEntryFirstMessage: entry.nextEntryFirstMessage,
    });
    const isActivityExpanded = turnExpansion.get(turn.turnId) === true;
    const hasLaterAssistant = entry.hasLaterAssistant === true;
    const foldContexts = useTurnFoldContexts(turn, hasLaterAssistant, isActivityExpanded, row.finalMessageId);
    const handleToggleActivity = React.useCallback(() => {
        onToggleTurnActivity(turn.turnId);
    }, [onToggleTurnActivity, turn.turnId]);

    const handleToggleRow = React.useCallback(() => {
        onToggleTurnActivity(row.key);
    }, [onToggleTurnActivity, row.key]);

    if (row.kind === 'turn-head') {
        return (
            <NestedRow depth={row.depth}>
                <TurnItem turn={turn} gapBelow={row.gapBelow} sessionPrompt={row.sessionPrompt} renderMessage={renderMessage} />
            </NestedRow>
        );
    }

    let content: React.ReactNode = null;
    if (row.kind === 'turn-line') {
        content = <TurnLine turn={turn} wake={row.wake} open={row.open} unread={row.unread} onToggle={handleToggleRow} />;
    } else if (row.kind === 'earlier-lines') {
        content = (
            <FoldLine icon="chat-history" open={row.open} onToggle={handleToggleRow}>
                <span className="min-w-0 truncate">{t('chat.exchange.earlier', { count: row.hiddenTurnIds.length })}</span>
            </FoldLine>
        );
    } else if (row.kind === 'turn-group') {
        content = <ActivityGroupLine turn={turn} parts={row.parts} open={row.open} onToggle={handleToggleRow} />;
    } else if (row.kind === 'turn-fold') {
        content = (
            <TurnFold turn={turn} hasLaterAssistant={hasLaterAssistant} expanded={isActivityExpanded}
                closed={turnExpansion.get(turn.turnId) === false} finalMessageId={row.finalMessageId} onToggle={handleToggleActivity} renderMessage={renderMessage} />
        );
    } else if (row.kind === 'turn-pages') {
        content = <TurnPagesRow turn={turn} />;
    } else {
        const message = turn.assistantMessages.find((candidate) => candidate.info.id === row.messageId);
        if (message) {
            content = (
                <MessageSliceContext.Provider value={row.slice}>
                    {row.final ? (
                        <LiveFinalActivityContext.Provider value={foldContexts.finalContext}>
                            {renderMessage(message)}
                        </LiveFinalActivityContext.Provider>
                    ) : renderMessage(message)}
                </MessageSliceContext.Provider>
            );
        }
    }

    const underFold = row.underFold;
    return (
        <NestedRow depth={row.depth}>
            <div className={cn('relative w-full', row.gapBelow && 'pb-2')} data-turn-row={turn.turnId} data-row-key={row.key}>
                <ShownPartStreamPhaseContext.Provider value={streamPhaseOf}>
                    {underFold ? (
                        <LiveTurnHoistedPagesContext.Provider value={foldContexts.hoistedPages}>{content}</LiveTurnHoistedPagesContext.Provider>
                    ) : content}
                </ShownPartStreamPhaseContext.Provider>
            </div>
        </NestedRow>
    );
});

TurnRow.displayName = 'TurnRow';
