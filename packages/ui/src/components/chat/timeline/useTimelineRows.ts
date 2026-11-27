import React from 'react';

import { turnHeaderCanStick } from '../lib/turns/stickyPrompt';
import { getTurnsWithLaterAssistant } from '../lib/turns/liveActivity';
import type { ChatMessageEntry } from '../lib/turns/types';
import { useTurnRecords } from '../hooks/useTurnRecords';
import { buildHistoryEntries, findFirstVisibleMessageId } from '../lib/turns/timelineEntries';
import { useLiveRowEntry } from './useLiveRowEntry';
import { useSupersededTurns } from './useSupersededTurns';
import { buildTimelineRows } from '../lib/turns/timelineRows';
import { streamPerfCount, streamPerfMeasure } from '@/stores/utils/streamDebug';
import { EMPTY_STATIC_ENTRY_MESSAGES, EMPTY_UNGROUPED_MESSAGE_IDS } from './emptyCollections';
import type { RenderEntry, RenderRow } from './types';

export const useTimelineRows = (
    sessionKey: string,
    displayMessages: ChatMessageEntry[],
    options: {
        showTurnChangedFiles: boolean;
        showReasoningTraces: boolean;
        stickyUserHeader: boolean;
        defaultActivityExpanded: boolean;
        groupedActivity: boolean;
        sessionIsWorking: boolean;
        directory?: string;
        turnExpansion: Map<string, boolean>;
    },
) => {
    const { showTurnChangedFiles, showReasoningTraces, stickyUserHeader, defaultActivityExpanded, groupedActivity, sessionIsWorking, directory, turnExpansion } = options;
    const { projection, staticTurns, streamingTurn } = useTurnRecords(displayMessages, {
        sessionKey,
        showTurnChangedFiles,
    });
    const hasUngroupedStaticEntries = projection.ungroupedMessageIds.size > 0;
    const tailHasAssistant = Boolean(streamingTurn?.assistantMessages.length);
    const turnsWithLaterAssistant = React.useMemo(() => {
        if (defaultActivityExpanded) return new Set<string>();
        const retired = getTurnsWithLaterAssistant(staticTurns);
        if (tailHasAssistant) {
            for (const turn of staticTurns) retired.add(turn.turnId);
        }
        return retired;
    }, [defaultActivityExpanded, staticTurns, tailHasAssistant]);
    const staticEntryMessages = hasUngroupedStaticEntries ? displayMessages : EMPTY_STATIC_ENTRY_MESSAGES;
    const staticEntryUngroupedIds = hasUngroupedStaticEntries ? projection.ungroupedMessageIds : EMPTY_UNGROUPED_MESSAGE_IDS;
    const trailingStreamingEntry = React.useMemo<RenderEntry | undefined>(() => {
        if (streamingTurn) {
            return {
                kind: 'turn',
                key: `turn:${streamingTurn.turnId}`,
                turn: streamingTurn,
                isLastTurn: streamingTurn.turnId === projection.lastTurnId,
            } satisfies RenderEntry;
        }

        if (projection.ungroupedMessageIds.size === 0) {
            return undefined;
        }

        const lastMessage = displayMessages[displayMessages.length - 1];
        if (!lastMessage || !projection.ungroupedMessageIds.has(lastMessage.info.id)) {
            return undefined;
        }

        return {
            kind: 'ungrouped',
            key: `msg:${lastMessage.info.id}`,
            message: lastMessage,
            nextMessage: undefined,
            isFirstRow: findFirstVisibleMessageId(displayMessages) === lastMessage.info.id,
        } satisfies RenderEntry;
    }, [displayMessages, projection.lastTurnId, projection.ungroupedMessageIds, streamingTurn]);

    if (trailingStreamingEntry) {
        streamPerfCount('ui.message_list.render.streaming');
    }

    const trailingEntryFirstMessage = trailingStreamingEntry
        ? (trailingStreamingEntry.kind === 'turn' ? trailingStreamingEntry.turn.userMessage : trailingStreamingEntry.message)
        : undefined;
    const previousHistoryEntriesRef = React.useRef<RenderEntry[]>([]);
    const hasStreamingTurn = Boolean(streamingTurn);
    const historyEntries = React.useMemo(() => streamPerfMeasure('ui.message_list.render_entries_ms', () => {
        const entries = buildHistoryEntries({
            staticTurns,
            lastTurnId: projection.lastTurnId,
            turnsWithLaterAssistant,
            messages: staticEntryMessages,
            ungroupedMessageIds: staticEntryUngroupedIds,
            hasStreamingTurn,
            trailingEntryFirstMessage,
        }, previousHistoryEntriesRef.current);
        previousHistoryEntriesRef.current = entries;
        return entries;
    }), [hasStreamingTurn, projection.lastTurnId, staticEntryMessages, staticEntryUngroupedIds, staticTurns, trailingEntryFirstMessage, turnsWithLaterAssistant]);

    const liveRowEntry = useLiveRowEntry(trailingStreamingEntry, { enabled: groupedActivity || !defaultActivityExpanded, directory, showTurnChangedFiles });

    const allEntries = React.useMemo(() => {
        return liveRowEntry ? [...historyEntries, liveRowEntry] : historyEntries;
    }, [historyEntries, liveRowEntry]);

    const superseded = useSupersededTurns(sessionKey, allEntries);

    const previousRowsRef = React.useRef<RenderRow[]>([]);
    const rows = React.useMemo(() => streamPerfMeasure('ui.message_list.render_rows_ms', () => {
        const next = buildTimelineRows(allEntries, {
            collapsedActivity: !defaultActivityExpanded,
            groupedActivity,
            working: sessionIsWorking,
            superseded,
            expandedTurns: turnExpansion,
            showReasoningTraces,
        }, previousRowsRef.current);
        previousRowsRef.current = next;
        return next;
    }), [allEntries, defaultActivityExpanded, groupedActivity, sessionIsWorking, showReasoningTraces, superseded, turnExpansion]);

    const stickyRowIndices = React.useMemo(() => {
        if (!stickyUserHeader) return undefined;
        const indices: number[] = [];
        rows.forEach((row, index) => {
            if (row.kind === 'turn-head' && !row.sessionPrompt && turnHeaderCanStick(row.entry.turn.userMessage)) indices.push(index);
        });
        return indices.length > 0 ? indices : undefined;
    }, [rows, stickyUserHeader]);

    return { projection, allEntries, trailingStreamingEntry, rows, stickyRowIndices };
};
