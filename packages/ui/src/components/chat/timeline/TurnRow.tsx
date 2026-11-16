import React from 'react';

import TurnItem from '../components/TurnItem';
import { TurnFold, TurnPagesRow } from '../components/LiveTurnActivity';
import { useTurnFoldContexts } from '../components/useTurnFold';
import { LiveFinalActivityContext, LiveTurnHoistedPagesContext } from '../components/liveActivityContext';
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

/** One list row of a turn (see `timelineRows.ts` for how a turn splits into rows). */
export const TurnRow = React.memo(({
    row,
    entry,
    turnExpansion,
    onToggleTurnActivity,
    ...rendererInput
}: TurnRowProps) => {
    const { turn } = entry;
    const renderMessage = useTurnMessageRenderer({
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

    if (row.kind === 'turn-head') {
        return <TurnItem turn={turn} gapBelow={row.gapBelow} renderMessage={renderMessage} />;
    }

    let content: React.ReactNode = null;
    if (row.kind === 'turn-fold') {
        content = (
            <TurnFold turn={turn} hasLaterAssistant={hasLaterAssistant} expanded={isActivityExpanded}
                finalMessageId={row.finalMessageId} onToggle={handleToggleActivity} renderMessage={renderMessage} />
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

    // Under a fold, a message does not draw the pages the turn hoists.
    const underFold = row.underFold;
    return (
        <div className={cn('relative w-full', row.gapBelow && 'pb-2')} data-turn-row={turn.turnId}>
            {underFold ? (
                <LiveTurnHoistedPagesContext.Provider value={foldContexts.hoistedPages}>{content}</LiveTurnHoistedPagesContext.Provider>
            ) : content}
        </div>
    );
});

TurnRow.displayName = 'TurnRow';
