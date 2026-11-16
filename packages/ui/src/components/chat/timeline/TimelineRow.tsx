import React from 'react';

import { streamPerfCount } from '@/stores/utils/streamDebug';
import { TurnRow } from './TurnRow';
import { UngroupedMessageRow } from './UngroupedMessageRow';
import type { RenderRow } from './types';
import { TimelineRowContext } from './timelineRowContext';

const subscribeNowhere = () => () => {};
const readNothing = () => null;

// Every row renders through this one component, live tail or history, so a
// row keeps its React tree when it moves between the two. The live tail
// changes on every send and on a revert; with a different component per role
// the row remounted, its state reset for a commit (a long user message lost
// its "show more" link), and the list measured that frame as the
// row's height. The next row then sat that much too high until a later
// re-measure.
export const TimelineRow = React.memo(({ row }: { row: RenderRow }) => {
    const context = React.useContext(TimelineRowContext);
    const live = context?.streamingTailKey === row.entry.key;
    const liveTail = context?.liveTail;
    const liveEntry = React.useSyncExternalStore(
        live && liveTail ? liveTail.subscribe : subscribeNowhere,
        live && liveTail ? () => {
            const entry = liveTail.get();
            return entry?.key === row.entry.key ? entry : null;
        } : readNothing,
    );
    if (!context) return null;

    const entry = liveEntry ?? row.entry;
    const activeStreamingMessageId = live ? context.activeStreamingMessageId : null;
    const activeStreamingPhase = live ? context.activeStreamingPhase : null;
    if (row.kind === 'ungrouped' || entry.kind === 'ungrouped') {
        if (entry.kind !== 'ungrouped') return null;
        return (
            <UngroupedMessageRow
                message={entry.message}
                nextMessage={entry.nextMessage}
                isFirstRow={entry.isFirstRow}
                scrollToBottom={context.scrollToBottom}
                shouldAnimateUserMessage={context.shouldAnimateUserMessage}
                onUserAnimationConsumed={context.onUserAnimationConsumed}
                activeStreamingMessageId={activeStreamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                reviewTransferDirection={context.reviewTransferDirection}
            />
        );
    }
    streamPerfCount('ui.message_list_entry.render');
    return (
        <TurnRow
            row={row}
            entry={entry}
            scrollToBottom={context.scrollToBottom}
            sessionIsWorking={live && context.sessionIsWorking}
            turnExpansion={context.turnExpansion}
            onToggleTurnActivity={context.onToggleTurnActivity}
            shouldAnimateUserMessage={context.shouldAnimateUserMessage}
            onUserAnimationConsumed={context.onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={context.reviewTransferDirection}
        />
    );
});

TimelineRow.displayName = 'TimelineRow';
