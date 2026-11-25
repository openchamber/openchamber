import React from 'react';

import { lineKey } from '../lib/turns/timelineRows';
import type { RenderEntry, RenderRow } from './types';

export const useTimelineRowIndexes = (rows: RenderRow[], allEntries: RenderEntry[]) => {
    return React.useMemo(() => {
        const messageIndexes = new Map<string, number>();
        const turnIndexes = new Map<string, number>();
        const rowIndexes = new Map<string, number>();
        const foldKeys = new Map<string, string[]>();
        const addFoldKey = (messageId: string, key: string) => {
            foldKeys.set(messageId, [...(foldKeys.get(messageId) ?? []), key]);
        };
        const earlierKeys = new Map<string, string>();
        const lineIndexes = new Map<string, number>();
        const all = new Map<string, string>();
        const foldIndexes = new Map<string, number>();
        rows.forEach((row, index) => {
            rowIndexes.set(row.key, index);
            if (row.kind === 'turn-message' && row.slice?.from) rowIndexes.set(`step:${row.messageId}:${row.slice.from.partId}:${row.slice.from.offset}`, index);
            if (row.kind === 'ungrouped') {
                messageIndexes.set(row.entry.message.info.id, index);
                return;
            }
            const { turnId, assistantMessageIds } = row.entry.turn;
            if (row.kind === 'turn-line') {
                lineIndexes.set(turnId, index);
                if (!row.open) for (const messageId of row.wake ? [turnId, ...assistantMessageIds] : assistantMessageIds) addFoldKey(messageId, row.key);
                if (!row.open) for (const group of row.groups) for (const messageId of group.messageIds) addFoldKey(messageId, group.key);
                return;
            }
            if (row.kind === 'earlier-lines') {
                if (row.open) return;
                for (const hiddenTurnId of row.hiddenTurnIds) {
                    lineIndexes.set(hiddenTurnId, index);
                    earlierKeys.set(hiddenTurnId, row.key);
                }
                for (const group of row.groups) for (const messageId of group.messageIds) addFoldKey(messageId, group.key);
                return;
            }
            if (row.kind === 'turn-group') {
                if (row.open) return;
                for (const messageId of row.messageIds) {
                    addFoldKey(messageId, row.key);
                    if (!messageIndexes.has(messageId)) messageIndexes.set(messageId, index);
                }
                return;
            }
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
            const fallback = foldIndexes.get(turnId) ?? lineIndexes.get(turnId) ?? turnIndexes.get(turnId);
            const lineIndex = lineIndexes.get(turnId);
            if (!turnIndexes.has(turnId) && lineIndex !== undefined) turnIndexes.set(turnId, lineIndex);
            if (fallback !== undefined && !messageIndexes.has(turnId)) messageIndexes.set(turnId, fallback);
            const earlierKey = earlierKeys.get(turnId);
            if (earlierKey) {
                for (const messageId of [turnId, ...entry.turn.assistantMessageIds]) {
                    addFoldKey(messageId, earlierKey);
                    addFoldKey(messageId, lineKey(turnId));
                }
            }
            assistantMessages.forEach((message, assistantIndex) => {
                const messageId = message.info.id;
                if (!messageIndexes.has(messageId) && fallback !== undefined) messageIndexes.set(messageId, fallback);
                all.set(messageId, turnId);
                if (assistantIndex < assistantMessages.length - 1) addFoldKey(messageId, turnId);
            });
        }
        return {
            messageIndexMap: messageIndexes,
            turnIndexMap: turnIndexes,
            rowIndexByKey: rowIndexes,
            foldKeysByMessageId: foldKeys,
            turnByAssistantMessageId: all,
        };
    }, [allEntries, rows]);
};
