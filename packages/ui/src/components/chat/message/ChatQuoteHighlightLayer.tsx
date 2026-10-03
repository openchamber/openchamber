/**
 * Highlights for chat quotes inside the transcript, painted with the CSS
 * Custom Highlight API so the rendered markdown is never touched.
 *
 * - Marks: every quote waiting in the composer's context chips stays softly
 *   highlighted in its message, so the reader sees where they left off. The
 *   mark the user hovers in the chip preview is drawn stronger.
 * - Reveal: clicking a quote (a chip entry, or a sent quote card) scrolls to
 *   its message and briefly flashes the fragment.
 * - Popover: hovering a mark (desktop) or tapping it (touch) opens its
 *   comment with edit and remove, acting on the draft through the publisher.
 *
 * The column owns a store (`hooks/chatQuoteHighlightStore.ts`) that publishers
 * write to, and renders `ChatQuoteHighlightLayer`, which subscribes to it and holds
 * all hover, popover and scroll-follow state. Highlight activity therefore
 * re-renders only the layer, never the chat column.
 *
 * Ranges are re-resolved from their anchors whenever a marked message
 * re-renders or remounts in the virtualized list. Runtimes without
 * `CSS.highlights` get the scroll without the highlight.
 */

import React from 'react';

import {
    findChatQuoteRoot,
    resolveChatQuoteAnchor,
    type ChatQuoteAnchor,
} from '@/lib/chatQuoteAnchor';

import type { ChatQuoteHighlightStore } from '../hooks/chatQuoteHighlightStore';
import { ChatQuoteMarkPopover } from './ChatQuoteMarkPopover';

const MARK_HIGHLIGHT = 'oc-chat-quote';
const FOCUS_HIGHLIGHT = 'oc-chat-quote-focus';
const FLASH_DURATION_MS = 1600;
// Hover must rest on a mark before its popover opens, so reading across the
// text does not flicker popovers; leaving gets a grace period to reach it.
const POPOVER_OPEN_DELAY_MS = 400;
const POPOVER_CLOSE_DELAY_MS = 250;
const CORRIDOR_PADDING_PX = 6;

const supportsHighlights = (): boolean => 'Highlight' in window && 'highlights' in CSS;

/** Who painted a set of ranges; each owner replaces only its own. */
type PaintOwner = { readonly layer: 'marks' | 'focus' | 'flash' };

// One registry entry per highlight name, merged across owners: several chat
// columns can be on screen, and CSS.highlights holds one Highlight per name.
const paintedRanges = new Map<string, Map<PaintOwner, Range[]>>();

function paint(name: string, owner: PaintOwner, ranges: Range[]): void {
    if (!supportsHighlights()) return;
    const owners = paintedRanges.get(name) ?? new Map<PaintOwner, Range[]>();
    if (ranges.length > 0) {
        owners.set(owner, ranges);
    } else {
        owners.delete(owner);
    }
    paintedRanges.set(name, owners);

    const all = [...owners.values()].flat();
    if (all.length === 0) {
        CSS.highlights.delete(name);
        return;
    }
    const highlight = new Highlight(...all);
    highlight.priority = name === FOCUS_HIGHLIGHT ? 1 : 0;
    CSS.highlights.set(name, highlight);
}

const nextFrame = (): Promise<void> => new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
});

interface ChatQuoteHighlightLayerProps {
    store: ChatQuoteHighlightStore;
    scrollNode: HTMLElement | null;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
}

function markAtPoint(ranges: Map<string, Range>, x: number, y: number): string | null {
    for (const [id, range] of ranges) {
        for (const rect of range.getClientRects()) {
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id;
        }
    }
    return null;
}

type PopoverState = { markId: string; rect: DOMRect };

export const ChatQuoteHighlightLayer = React.memo(function ChatQuoteHighlightLayer({
    store,
    scrollNode,
    scrollToMessage,
}: ChatQuoteHighlightLayerProps) {
    const marks = React.useSyncExternalStore(store.subscribe, store.getMarks);
    const chipFocusedMarkId = React.useSyncExternalStore(store.subscribe, store.getChipFocus);
    const [popover, setPopover] = React.useState<PopoverState | null>(null);
    const [editing, setEditing] = React.useState(false);
    const focusedMarkId = chipFocusedMarkId ?? popover?.markId ?? null;
    // Resolved ranges of the marks currently mounted, for hit-testing.
    const rangesRef = React.useRef(new Map<string, Range>());
    const [owners] = React.useState(() => ({
        marks: { layer: 'marks' } satisfies PaintOwner,
        focus: { layer: 'focus' } satisfies PaintOwner,
        flash: { layer: 'flash' } satisfies PaintOwner,
    }));
    const scrollNodeRef = React.useRef(scrollNode);
    scrollNodeRef.current = scrollNode;
    const scrollToMessageRef = React.useRef(scrollToMessage);
    scrollToMessageRef.current = scrollToMessage;
    const flashTimerRef = React.useRef<number | null>(null);

    React.useEffect(() => {
        if (!scrollNode || marks.length === 0) return;
        const markedMessageIds = new Set(marks.map((mark) => mark.messageId));
        const ranges = rangesRef.current;

        let frame: number | null = null;
        const repaint = () => {
            frame = null;
            const marked: Range[] = [];
            const focused: Range[] = [];
            ranges.clear();
            for (const mark of marks) {
                const root = findChatQuoteRoot(scrollNode, mark.messageId);
                const range = root ? resolveChatQuoteAnchor(root, mark.anchor) : null;
                if (!range) continue;
                ranges.set(mark.id, range);
                marked.push(range);
                if (mark.id === focusedMarkId) focused.push(range);
            }
            paint(MARK_HIGHLIGHT, owners.marks, marked);
            paint(FOCUS_HIGHLIGHT, owners.focus, focused);
        };

        // Streaming rewrites the live message many times a second; only
        // mutations inside a marked message, or above every message (rows
        // mounting and unmounting), can move a mark.
        const observer = new MutationObserver((records) => {
            if (frame !== null) return;
            const relevant = records.some((record) => {
                const element = record.target instanceof Element ? record.target : record.target.parentElement;
                const messageId = element?.closest('[data-message-id]')?.getAttribute('data-message-id');
                return messageId === undefined || messageId === null || markedMessageIds.has(messageId);
            });
            if (relevant) frame = window.requestAnimationFrame(repaint);
        });
        observer.observe(scrollNode, { childList: true, subtree: true, characterData: true });
        repaint();

        return () => {
            observer.disconnect();
            if (frame !== null) window.cancelAnimationFrame(frame);
            ranges.clear();
            paint(MARK_HIGHLIGHT, owners.marks, []);
            paint(FOCUS_HIGHLIGHT, owners.focus, []);
        };
    }, [focusedMarkId, marks, owners, scrollNode]);

    // A flash paints both layers, so it reads as strong as a hovered mark.
    const paintFlash = React.useCallback((ranges: Range[]) => {
        paint(MARK_HIGHLIGHT, owners.flash, ranges);
        paint(FOCUS_HIGHLIGHT, owners.flash, ranges);
    }, [owners]);

    React.useEffect(() => () => {
        if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
        paintFlash([]);
    }, [paintFlash]);

    const reveal = React.useCallback((messageId: string, anchor: ChatQuoteAnchor) => {
        void (async () => {
            // Scrolling through the timeline controller releases live follow
            // and mounts the row when the virtualized list dropped it. The
            // controller only knows messages it could place in a turn; a row
            // already on screen is scrolled to directly below.
            const mounted = scrollNodeRef.current ? findChatQuoteRoot(scrollNodeRef.current, messageId) : null;
            const scrolled = await scrollToMessageRef.current(messageId, { behavior: 'auto' });
            if (!scrolled && !mounted) return;
            await nextFrame();
            const node = scrollNodeRef.current;
            const root = node ? findChatQuoteRoot(node, messageId) : null;
            const range = root ? resolveChatQuoteAnchor(root, anchor) : null;
            if (!range) return;

            range.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
            if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
            paintFlash([range]);
            flashTimerRef.current = window.setTimeout(() => {
                flashTimerRef.current = null;
                paintFlash([]);
            }, FLASH_DURATION_MS);
        })();
    }, [paintFlash]);

    React.useEffect(() => {
        store.setRevealHandler(reveal);
        return () => store.setRevealHandler(null);
    }, [reveal, store]);

    const openMark = popover ? marks.find((mark) => mark.id === popover.markId) ?? null : null;
    const editingRef = React.useRef(editing);
    editingRef.current = editing;
    const popoverRef = React.useRef(popover);
    popoverRef.current = popover;
    const openTimerRef = React.useRef<number | null>(null);
    const closeTimerRef = React.useRef<number | null>(null);
    const popoverElementRef = React.useRef<HTMLDivElement>(null);

    // The box spanning the open mark and its popover. A pointer crossing it is
    // on its way to the popover's buttons, however slowly or diagonally, so it
    // must not start the close.
    const isInPopoverCorridor = React.useCallback((x: number, y: number): boolean => {
        const open = popoverRef.current;
        const range = open ? rangesRef.current.get(open.markId) : null;
        const box = popoverElementRef.current?.getBoundingClientRect();
        if (!range || !box) return false;
        const mark = range.getBoundingClientRect();
        return x >= Math.min(mark.left, box.left) - CORRIDOR_PADDING_PX
            && x <= Math.max(mark.right, box.right) + CORRIDOR_PADDING_PX
            && y >= Math.min(mark.top, box.top) - CORRIDOR_PADDING_PX
            && y <= Math.max(mark.bottom, box.bottom) + CORRIDOR_PADDING_PX;
    }, []);

    const clearTimers = React.useCallback(() => {
        if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
        if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
        openTimerRef.current = null;
        closeTimerRef.current = null;
    }, []);

    const closePopover = React.useCallback(() => {
        clearTimers();
        setPopover(null);
        setEditing(false);
    }, [clearTimers]);

    const showPopover = React.useCallback((markId: string) => {
        const range = rangesRef.current.get(markId);
        if (!range) return;
        setPopover({ markId, rect: range.getBoundingClientRect() });
    }, []);

    const scheduleClose = React.useCallback(() => {
        if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
        if (editingRef.current || !popoverRef.current || closeTimerRef.current !== null) return;
        closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = null;
            if (!editingRef.current) setPopover(null);
        }, POPOVER_CLOSE_DELAY_MS);
    }, []);

    const cancelClose = React.useCallback(() => {
        if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
    }, []);

    // A mark that was sent, removed or dropped from the list closes its popover.
    React.useEffect(() => {
        if (popover && !openMark) closePopover();
    }, [closePopover, openMark, popover]);

    React.useEffect(() => clearTimers, [clearTimers]);

    React.useEffect(() => {
        if (!scrollNode || marks.length === 0) return;
        let lastPointerType = 'mouse';

        const handlePointerDown = (event: PointerEvent) => {
            lastPointerType = event.pointerType;
        };

        // Desktop: a resting mouse opens the mark under it. Keeping it open
        // is decided by position alone while it is open (below).
        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse' || event.buttons !== 0 || editingRef.current) return;
            const hit = markAtPoint(rangesRef.current, event.clientX, event.clientY);
            if (!hit || popoverRef.current?.markId === hit) {
                if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
                openTimerRef.current = null;
                return;
            }
            if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
            openTimerRef.current = window.setTimeout(() => {
                openTimerRef.current = null;
                showPopover(hit);
            }, POPOVER_OPEN_DELAY_MS);
        };

        // Touch: a single tap on a mark toggles its popover. A tap that ends a
        // text selection is left to the selection menu.
        const handleClick = (event: MouseEvent) => {
            if (lastPointerType === 'mouse') return;
            if (window.getSelection()?.isCollapsed === false) return;
            const hit = markAtPoint(rangesRef.current, event.clientX, event.clientY);
            if (!hit) return;
            if (popoverRef.current?.markId === hit) {
                closePopover();
            } else {
                setEditing(false);
                showPopover(hit);
            }
        };

        scrollNode.addEventListener('pointerdown', handlePointerDown);
        scrollNode.addEventListener('pointermove', handlePointerMove);
        scrollNode.addEventListener('click', handleClick);
        return () => {
            scrollNode.removeEventListener('pointerdown', handlePointerDown);
            scrollNode.removeEventListener('pointermove', handlePointerMove);
            scrollNode.removeEventListener('click', handleClick);
        };
    }, [closePopover, marks.length, scrollNode, showPopover]);

    // While open: stay open while the mouse is on the mark, the popover or the
    // corridor between them (enter/leave events do not cross the portal
    // reliably, so position decides), follow the mark as the chat scrolls,
    // and close on a press anywhere but the popover or the mark itself.
    const openMarkId = popover?.markId ?? null;
    React.useEffect(() => {
        if (!openMarkId) return;
        let frame: number | null = null;
        const follow = () => {
            if (frame !== null) return;
            frame = window.requestAnimationFrame(() => {
                frame = null;
                const range = rangesRef.current.get(openMarkId);
                if (!range) {
                    closePopover();
                    return;
                }
                const rect = range.getBoundingClientRect();
                setPopover((current) => (current && current.markId === openMarkId ? { ...current, rect } : current));
            });
        };
        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse' || editingRef.current) return;
            if (isInPopoverCorridor(event.clientX, event.clientY)
                || markAtPoint(rangesRef.current, event.clientX, event.clientY) === openMarkId) {
                cancelClose();
            } else {
                scheduleClose();
            }
        };
        const handlePressOutside = (event: PointerEvent) => {
            // SAFETY: a pointer event target inside the document is always a
            // Node; `contains` only needs that.
            if (popoverElementRef.current?.contains(event.target as Node)) return;
            if (markAtPoint(rangesRef.current, event.clientX, event.clientY) === openMarkId) return;
            closePopover();
        };
        document.addEventListener('scroll', follow, { capture: true, passive: true });
        window.addEventListener('resize', follow);
        document.addEventListener('pointerdown', handlePressOutside);
        document.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
        return () => {
            if (frame !== null) window.cancelAnimationFrame(frame);
            document.removeEventListener('scroll', follow, { capture: true });
            window.removeEventListener('resize', follow);
            document.removeEventListener('pointerdown', handlePressOutside);
            document.removeEventListener('pointermove', handlePointerMove, { capture: true });
        };
    }, [cancelClose, closePopover, isInPopoverCorridor, openMarkId, scheduleClose]);

    return popover && openMark ? (
        <ChatQuoteMarkPopover
            ref={popoverElementRef}
            anchorRect={popover.rect}
            comment={openMark.comment}
            editing={editing}
            onEditingChange={setEditing}
            onSave={openMark.updateComment}
            onRemove={() => {
                openMark.remove();
                closePopover();
            }}
        />
    ) : null;
});
