import React from 'react';

import type { RenderEntry, RenderRow } from './types';

export const useTimelineRowIndexes = (rows: RenderRow[], allEntries: RenderEntry[]) => {
    return React.useMemo(() => {
        const messageIndexes = new Map<string, number>();
        const turnIndexes = new Map<string, number>();
        const rowIndexes = new Map<string, number>();
        const collapsible = new Map<string, string>();
        const all = new Map<string, string>();
        const foldIndexes = new Map<string, number>();
        rows.forEach((row, index) => {
            rowIndexes.set(row.key, index);
            if (row.kind === 'ungrouped') {
                messageIndexes.set(row.entry.message.info.id, index);
                return;
            }
            const { turnId } = row.entry.turn;
            if (row.kind === 'turn-head') {
                turnIndexes.set(turnId, index);
                messageIndexes.set(row.entry.turn.userMessage.info.id, index);
            } else if (row.kind === 'turn-fold') {
                foldIndexes.set(turnId, index);
            } else if (row.kind === 'turn-message' && !row.slice?.from) {
                messageIndexes.set(row.messageId, index);
            }
        });
        for (const entry of allEntries) {
            if (entry.kind !== 'turn') continue;
            const { turnId, assistantMessages } = entry.turn;
            const fallback = foldIndexes.get(turnId) ?? turnIndexes.get(turnId);
            assistantMessages.forEach((message, assistantIndex) => {
                const messageId = message.info.id;
                if (!messageIndexes.has(messageId) && fallback !== undefined) messageIndexes.set(messageId, fallback);
                all.set(messageId, turnId);
                if (assistantIndex < assistantMessages.length - 1) collapsible.set(messageId, turnId);
            });
        }
        return {
            messageIndexMap: messageIndexes,
            turnIndexMap: turnIndexes,
            rowIndexByKey: rowIndexes,
            collapsibleTurnByMessageId: collapsible,
            turnByAssistantMessageId: all,
        };
    }, [allEntries, rows]);
};
