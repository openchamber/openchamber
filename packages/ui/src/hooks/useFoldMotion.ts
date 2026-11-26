import React from 'react';
import type { LegendListRef } from '@legendapp/list/react';

import { onEachFrame } from '@/lib/timing/onEachFrame';
import { captureFoldMotion, playFoldMotion, stopFoldMotion, type FoldMotionStart } from '@/components/chat/timeline/foldMotion';
import type { RenderRow, ToggleTurnActivity } from '@/components/chat/timeline/types';

const foldLineKey = (rows: readonly RenderRow[], key: string): string | undefined => {
    if (key.startsWith('line:') || key.startsWith('group:') || key.startsWith('earlier:')) return key;
    return rows.find((row) => row.kind === 'turn-fold' && row.entry.turn.turnId === key && row.finalMessageId !== undefined)?.key;
};

const NO_ROWS: ReadonlySet<string> = new Set();

const rowsInFold = (rows: readonly RenderRow[], key: string): ReadonlySet<string> => {
    const index = rows.findIndex((row) => row.key === key);
    const fold = rows[index];
    const inside = new Set<string>();
    if (!fold || fold.kind === 'ungrouped') return inside;
    const hidden = fold.kind === 'earlier-lines' ? fold.hiddenTurnIds : [];
    for (const row of rows.slice(index + 1)) {
        if (row.kind === 'ungrouped' || (row.depth <= fold.depth && !hidden.includes(row.entry.turn.turnId))) break;
        inside.add(row.key);
    }
    return inside;
};

const selfClosedGroup = (previous: readonly RenderRow[], next: readonly RenderRow[]): { key: string; inside: ReadonlySet<string> } | undefined => {
    const row = [...previous].reverse().find((candidate) => candidate.kind === 'turn-group');
    if (!row || row.kind !== 'turn-group' || row.open) return undefined;
    const inside = rowsInFold(previous, row.key);
    const closed = inside.size > 0 && next.some((candidate) => candidate.key === row.key) && rowsInFold(next, row.key).size === 0;
    return closed ? { key: row.key, inside } : undefined;
};

export const useFoldMotion = (
    listRef: React.RefObject<LegendListRef | null>,
    sessionKey: string,
    rows: readonly RenderRow[],
    expansion: ReadonlyMap<string, boolean>,
    toggle: ToggleTurnActivity,
) => {
    const startRef = React.useRef<FoldMotionStart | null>(null);
    const movingRef = React.useRef<HTMLElement | null>(null);
    const cancelFrameRef = React.useRef<(() => void) | null>(null);
    const expansionRef = React.useRef(expansion);
    expansionRef.current = expansion;
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;

    React.useLayoutEffect(() => {
        const start = startRef.current;
        const container = listRef.current?.getScrollableNode();
        startRef.current = null;
        if (!start || !container) return;
        cancelFrameRef.current?.();
        movingRef.current = container;
        cancelFrameRef.current = onEachFrame(() => {
            if (container.isConnected) playFoldMotion(container, start);
            return false;
        });
    }, [expansion, listRef, rows]);

    React.useLayoutEffect(() => () => {
        startRef.current = null;
        cancelFrameRef.current?.();
        if (movingRef.current) stopFoldMotion(movingRef.current);
    }, [sessionKey]);

    const captureSelfClosing = React.useCallback((previous: readonly RenderRow[], next: readonly RenderRow[]) => {
        const container = listRef.current?.getScrollableNode();
        const closed = container && !startRef.current ? selfClosedGroup(previous, next) : undefined;
        if (container && closed) startRef.current = captureFoldMotion(container, closed.key, closed.inside);
    }, [listRef]);

    const toggleWithMotion = React.useCallback<ToggleTurnActivity>((key) => {
        const container = listRef.current?.getScrollableNode();
        const lineKey = foldLineKey(rowsRef.current, key);
        startRef.current = container && lineKey ? captureFoldMotion(container, lineKey, expansionRef.current.get(key) === true ? rowsInFold(rowsRef.current, lineKey) : NO_ROWS) : null;
        toggle(key);
    }, [listRef, toggle]);

    return { toggle: toggleWithMotion, captureSelfClosing };
};
