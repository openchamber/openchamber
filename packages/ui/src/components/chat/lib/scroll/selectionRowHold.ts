// Keeps a text selection made in the transcript where the reader put it
// (the scroll documentation, "A selection keeps its rows").
import React from 'react';
import type { LegendListRef } from '@legendapp/list/react';

type SelectionEnd = { node: Node; offset: number };

const elementOf = (end: SelectionEnd): Element | null => (end.node instanceof Element ? end.node : end.node.parentElement);

// Where `end` is on screen.
const caretRect = (end: SelectionEnd): DOMRect | undefined => {
    const range = document.createRange();
    range.setStart(end.node, end.offset);
    return range.getClientRects()[0] ?? elementOf(end)?.getBoundingClientRect();
};

// Whether the page at `end`'s spot on screen shows something else: the spot is
// scrolled out of the list, or the composer or a panel covers it.
const isHidden = (end: SelectionEnd): boolean => {
    const element = elementOf(end);
    const rect = caretRect(end);
    if (!element?.isConnected || !rect) return false;
    const hit = document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2);
    return !hit || !(element.contains(hit) || hit.contains(element));
};

// Of the remembered ends, the one farthest from the focus on screen: the
// reader drags the other one.
const fixedEnd = (ends: readonly SelectionEnd[], focus: SelectionEnd): SelectionEnd | undefined => {
    const top = caretRect(focus)?.top ?? 0;
    const distance = (end: SelectionEnd) => Math.abs((caretRect(end)?.top ?? top) - top);
    return [...ends].sort((a, b) => distance(b) - distance(a))[0];
};

// The list row that holds `node`, among the rows it has mounted.
const rowIndexOf = (state: ReturnType<LegendListRef['getState']>, node: Node | null, held: readonly number[]): number | null => {
    if (!node) return null;
    const first = Math.max(0, Math.min(state.startBuffered, ...held));
    const last = Math.max(state.endBuffered, ...held);
    for (let index = first; index <= last; index += 1) {
        if (state.elementAtIndex(index)?.contains(node)) return index;
    }
    return null;
};

/**
 * While a selection in the list lasts, the rows it spans stay mounted and its
 * fixed end stays where the reader put it. Returns the list's `alwaysRender`
 * for those rows.
 */
export const useSelectionRowHold = (listRef: React.RefObject<LegendListRef | null>): { keys: string[] } | undefined => {
    const [held, setHeld] = React.useState<{ keys: string[] } | undefined>(undefined);
    const heldRef = React.useRef(held);
    heldRef.current = held;

    React.useEffect(() => {
        // The ends in rows of the last selection whose anchor was in one.
        let ends: SelectionEnd[] = [];
        const hold = (keys: string[] | undefined) => {
            if (heldRef.current?.keys.join('\n') === keys?.join('\n')) return;
            heldRef.current = keys && { keys };
            setHeld(heldRef.current);
        };
        const release = () => {
            ends = [];
            hold(undefined);
        };
        const selectionChange = () => {
            const list = listRef.current;
            const state = list?.getState();
            const selection = document.getSelection();
            if (!list || !state || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) {
                release();
                return;
            }
            const held = (heldRef.current?.keys ?? [])
                .map((key) => state.indexByKey(key))
                .filter((index): index is number => index !== undefined);
            const anchorRow = rowIndexOf(state, selection.anchorNode, held);
            const focusRow = rowIndexOf(state, selection.focusNode, held);
            // Chrome on Android places the end that stays put again from its
            // spot on screen when a handle drag starts. With that end scrolled
            // out of the transcript, the spot is outside the list, and the
            // anchor landed at the top of the page: the selection grew to the
            // whole chat.
            if (anchorRow === null && focusRow !== null) {
                const fixed = fixedEnd(ends, { node: selection.focusNode, offset: selection.focusOffset });
                if (fixed && isHidden(fixed)) {
                    selection.setBaseAndExtent(fixed.node, fixed.offset, selection.focusNode, selection.focusOffset);
                    return;
                }
            }
            if (anchorRow === null && focusRow === null) {
                // The first step of that drag can put the anchor in the list's
                // header and the focus in a panel over it; only a selection that
                // left the list ends the hold.
                const scroller = list.getScrollableNode();
                if (!scroller?.contains(selection.anchorNode) && !scroller?.contains(selection.focusNode)) release();
                return;
            }
            if (anchorRow !== null) {
                ends = [{ node: selection.anchorNode, offset: selection.anchorOffset }];
                if (focusRow !== null) ends.push({ node: selection.focusNode, offset: selection.focusOffset });
            }
            // The held rows only grow until the selection ends: an end in the
            // list's header or footer is in no row.
            const rows = [...held, ...[anchorRow, focusRow].filter((row): row is number => row !== null)];
            const keys = state.data
                .slice(Math.min(...rows), Math.max(...rows) + 1)
                .map((row: { key: string }) => row.key);
            hold(keys);
        };
        document.addEventListener('selectionchange', selectionChange);
        return () => document.removeEventListener('selectionchange', selectionChange);
    }, [listRef]);

    return held;
};
