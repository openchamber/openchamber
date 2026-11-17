import React from 'react';
import type { LegendListRef } from '@legendapp/list/react';

type SelectionEnd = { node: Node; offset: number };

const elementOf = (end: SelectionEnd): Element | null => (end.node instanceof Element ? end.node : end.node.parentElement);

const caretRect = (end: SelectionEnd): DOMRect | undefined => {
    const length = end.node instanceof CharacterData ? end.node.length : end.node.childNodes.length;
    if (end.offset > length) return undefined;
    const range = document.createRange();
    range.setStart(end.node, end.offset);
    return range.getClientRects()[0] ?? elementOf(end)?.getBoundingClientRect();
};

const isHidden = (end: SelectionEnd): boolean => {
    const element = elementOf(end);
    const rect = caretRect(end);
    if (!element?.isConnected || !rect) return false;
    const hit = document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2);
    return !hit || !(element.contains(hit) || hit.contains(element));
};

const fixedEnd = (ends: readonly SelectionEnd[], focus: SelectionEnd): SelectionEnd | undefined => {
    const top = caretRect(focus)?.top ?? 0;
    const distance = (end: SelectionEnd) => Math.abs((caretRect(end)?.top ?? top) - top);
    return [...ends].sort((a, b) => distance(b) - distance(a))[0];
};

const rowIndexOf = (state: ReturnType<LegendListRef['getState']>, node: Node | null, held: readonly number[]): number | null => {
    if (!node) return null;
    const first = Math.max(0, Math.min(state.startBuffered, ...held));
    const last = Math.max(state.endBuffered, ...held);
    for (let index = first; index <= last; index += 1) {
        if (state.elementAtIndex(index)?.contains(node)) return index;
    }
    return null;
};

export const useSelectionRowHold = (listRef: React.RefObject<LegendListRef | null>): { keys: string[] } | undefined => {
    const [held, setHeld] = React.useState<{ keys: string[] } | undefined>(undefined);
    const heldRef = React.useRef(held);
    heldRef.current = held;

    React.useEffect(() => {
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
            if (anchorRow === null && focusRow !== null) {
                const fixed = fixedEnd(ends, { node: selection.focusNode, offset: selection.focusOffset });
                if (fixed && isHidden(fixed)) {
                    selection.setBaseAndExtent(fixed.node, fixed.offset, selection.focusNode, selection.focusOffset);
                    return;
                }
            }
            if (anchorRow === null && focusRow === null) {
                const scroller = list.getScrollableNode();
                if (!scroller?.contains(selection.anchorNode) && !scroller?.contains(selection.focusNode)) release();
                return;
            }
            if (anchorRow !== null) {
                ends = [{ node: selection.anchorNode, offset: selection.anchorOffset }];
                if (focusRow !== null) ends.push({ node: selection.focusNode, offset: selection.focusOffset });
            }
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
