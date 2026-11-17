
import React from 'react';

import {
    findChatQuoteRoots,
    findUiRenderQuoteRoot,
    resolveChatQuoteRanges,
    type ChatQuoteAnchor,
} from '@/lib/chatQuoteAnchor';

import type { ChatQuoteHighlightStore } from '../hooks/chatQuoteHighlightStore';
import { ChatColumnSessionContext } from '../chatColumnSession';
import { ChatQuoteMarkPopover } from './ChatQuoteMarkPopover';
import type { HtmlRenderMark } from './parts/htmlRender';
import { onPageMarkClick, revealPageMark, setPageMarks } from './pageQuoteBridge';
import { dispatchNavigationRelease } from '../lib/scroll/timelineScrollIntent';

const MARK_HIGHLIGHT = 'oc-chat-quote';
const FOCUS_HIGHLIGHT = 'oc-chat-quote-focus';
const FLASH_DURATION_MS = 1600;
const POPOVER_OPEN_DELAY_MS = 400;
const POPOVER_CLOSE_DELAY_MS = 250;
const CORRIDOR_PADDING_PX = 6;
const REVEAL_ATTEMPTS = 10;

const supportsHighlights = (): boolean => 'Highlight' in window && 'highlights' in CSS;

type PaintOwner = { readonly layer: 'marks' | 'focus' | 'flash' };

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
    loadHistoryUntilMessage: (messageId: string) => Promise<boolean>;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    resolveUiPageMessageId?: (messageId: string, partId: string) => string;
    scrollToUiPageRow?: (messageId: string) => boolean;
}

function markAtPoint(ranges: Map<string, Range[]>, x: number, y: number): string | null {
    for (const [id, parts] of ranges) {
        for (const range of parts) {
            for (const rect of range.getClientRects()) {
                if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id;
            }
        }
    }
    return null;
}

const boundsOf = (parts: Range[]): DOMRect => {
    const [first, ...rest] = parts.map((range) => range.getBoundingClientRect());
    let { left, top, right, bottom } = first;
    for (const rect of rest) {
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
    }
    return new DOMRect(left, top, right - left, bottom - top);
};

type PopoverState = {
    markId: string;
    rect: DOMRect;
    measure?: () => DOMRect;
    portal?: HTMLElement | null;
};


const lowestRowOf = (scrollNode: HTMLElement, messageId: string): Element | null => {
    let lowest: Element | null = null;
    for (const message of scrollNode.querySelectorAll(`[data-message-id="${CSS.escape(messageId)}"]`)) {
        if (!lowest || message.getBoundingClientRect().bottom > lowest.getBoundingClientRect().bottom) lowest = message;
    }
    return lowest;
};

const messageContinuesBelow = (scrollNode: HTMLElement, messageId: string): boolean => (
    lowestRowOf(scrollNode, messageId)?.hasAttribute('data-message-continues') === true
);

const scrollToNextSlice = (scrollNode: HTMLElement, messageId: string): void => {
    const lowest = lowestRowOf(scrollNode, messageId);
    if (lowest) scrollNode.scrollTop += lowest.getBoundingClientRect().bottom - scrollNode.getBoundingClientRect().top;
};

export const ChatQuoteHighlightLayer = React.memo(function ChatQuoteHighlightLayer({
    store,
    scrollNode,
    loadHistoryUntilMessage,
    scrollToMessage,
    resolveUiPageMessageId,
    scrollToUiPageRow,
}: ChatQuoteHighlightLayerProps) {
    const session = React.useContext(ChatColumnSessionContext);
    const marks = React.useSyncExternalStore(store.subscribe, store.getMarks);
    const chipFocusedMarkId = React.useSyncExternalStore(store.subscribe, store.getChipFocus);
    const [popover, setPopover] = React.useState<PopoverState | null>(null);
    const [editing, setEditing] = React.useState(false);
    const focusedMarkId = chipFocusedMarkId ?? popover?.markId ?? null;
    const rangesRef = React.useRef(new Map<string, Range[]>());
    const [owners] = React.useState(() => ({
        marks: { layer: 'marks' } satisfies PaintOwner,
        focus: { layer: 'focus' } satisfies PaintOwner,
        flash: { layer: 'flash' } satisfies PaintOwner,
    }));
    const [pageOwner] = React.useState(() => Symbol('page marks owner'));
    const marksRef = React.useRef(marks);
    marksRef.current = marks;
    const scrollNodeRef = React.useRef(scrollNode);
    scrollNodeRef.current = scrollNode;
    const scrollToMessageRef = React.useRef(scrollToMessage);
    scrollToMessageRef.current = scrollToMessage;
    const resolveUiPageMessageIdRef = React.useRef(resolveUiPageMessageId);
    resolveUiPageMessageIdRef.current = resolveUiPageMessageId;
    const scrollToUiPageRowRef = React.useRef(scrollToUiPageRow);
    scrollToUiPageRowRef.current = scrollToUiPageRow;
    const loadHistoryUntilMessageRef = React.useRef(loadHistoryUntilMessage);
    loadHistoryUntilMessageRef.current = loadHistoryUntilMessage;
    const revealGenerationRef = React.useRef(0);
    const flashTimerRef = React.useRef<number | null>(null);
    const cancelRevealRef = React.useRef<(() => void) | null>(null);

    React.useEffect(() => () => {
        revealGenerationRef.current += 1;
        cancelRevealRef.current?.();
    }, [scrollNode, store, session?.sessionId, session?.directory]);

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
                if (mark.anchor.page && mark.anchor.page.kind !== 'ui') continue;
                const root = mark.anchor.page ? findUiRenderQuoteRoot(scrollNode, mark.messageId, mark.anchor.page.partId) : null;
                const parts = resolveChatQuoteRanges(mark.anchor.page ? root ? [root] : [] : findChatQuoteRoots(scrollNode, mark.messageId), mark.anchor);
                if (!parts) continue;
                ranges.set(mark.id, parts);
                marked.push(...parts);
                if (mark.id === focusedMarkId) focused.push(...parts);
            }
            paint(MARK_HIGHLIGHT, owners.marks, marked);
            paint(FOCUS_HIGHLIGHT, owners.focus, focused);
        };

        const observer = new MutationObserver((records) => {
            if (frame !== null) return;
            const relevant = records.some((record) => {
                const element = record.target instanceof Element ? record.target : record.target.parentElement;
                const messageId = element?.closest('[data-message-id]')?.getAttribute('data-message-id');
                const pageMessageId = element?.closest('[data-ui-render-message]')?.getAttribute('data-ui-render-message');
                return messageId === undefined || messageId === null || markedMessageIds.has(messageId) || (pageMessageId != null && markedMessageIds.has(pageMessageId));
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

    React.useEffect(() => {
        const byPart = new Map<string, HtmlRenderMark[]>();
        for (const mark of marks) {
            const partId = mark.anchor.page?.partId;
            if (!partId || mark.anchor.page?.kind === 'ui') continue;
            const forPart = byPart.get(partId) ?? [];
            forPart.push({ id: mark.id, anchor: mark.anchor, focused: mark.id === focusedMarkId });
            byPart.set(partId, forPart);
        }
        setPageMarks(pageOwner, byPart);
    }, [focusedMarkId, marks, pageOwner]);

    React.useEffect(() => () => setPageMarks(pageOwner, new Map()), [pageOwner]);

    const paintFlash = React.useCallback((ranges: Range[]) => {
        paint(MARK_HIGHLIGHT, owners.flash, ranges);
        paint(FOCUS_HIGHLIGHT, owners.flash, ranges);
    }, [owners]);

    React.useEffect(() => () => {
        if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
        paintFlash([]);
    }, [paintFlash]);

    const reveal = React.useCallback((messageId: string, anchor: ChatQuoteAnchor) => {
        cancelRevealRef.current?.();
        const scrollToMessage = scrollToMessageRef.current;
        const scrollNode = scrollNodeRef.current;
        const generation = ++revealGenerationRef.current;
        let cancelled = false;
        let observer: MutationObserver | null = null;
        let frame: number | null = null;
        const isCurrent = () => !cancelled && generation === revealGenerationRef.current && scrollNode === scrollNodeRef.current;
        const cancel = () => {
            cancelled = true;
            observer?.disconnect();
            if (frame !== null) window.cancelAnimationFrame(frame);
            frame = null;
            for (const event of ['wheel', 'touchstart', 'pointerdown', 'openchamber:frame-scroll']) {
                scrollNode?.removeEventListener(event, cancel);
            }
            scrollNode?.removeEventListener('keydown', cancelOnKey);
            if (cancelRevealRef.current === cancel) cancelRevealRef.current = null;
        };
        const cancelOnKey = (event: KeyboardEvent) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
        };
        cancelRevealRef.current = cancel;
        for (const event of ['wheel', 'touchstart', 'pointerdown', 'openchamber:frame-scroll']) {
            scrollNode?.addEventListener(event, cancel, { passive: true });
        }
        scrollNode?.addEventListener('keydown', cancelOnKey);
        void (async () => {
            const loaded = await loadHistoryUntilMessageRef.current(messageId).catch(() => false);
            if (!loaded || !isCurrent()) return;

            if (anchor.page && anchor.page.kind !== 'ui') {
                const { partId } = anchor.page;
                await scrollToMessage(messageId, { behavior: 'auto' }).catch(() => false);
                for (let attempt = 0; attempt < REVEAL_ATTEMPTS; attempt += 1) {
                    await nextFrame();
                    if (!isCurrent()) return;
                    if (revealPageMark(partId, anchor)) return;
                }
                return;
            }
            const targetMessageId = anchor.page?.kind === 'ui'
                ? resolveUiPageMessageIdRef.current?.(messageId, anchor.page.partId) ?? messageId
                : messageId;
            const uiRoot = anchor.page && scrollNode ? findUiRenderQuoteRoot(scrollNode, messageId, anchor.page.partId) : null;
            const mounted = uiRoot !== null || (scrollNodeRef.current ? findChatQuoteRoots(scrollNodeRef.current, messageId).length > 0 : false);
            let pageRowRequested = anchor.page?.kind === 'ui' && uiRoot === null && scrollToUiPageRowRef.current?.(messageId) === true;
            const scrolled = uiRoot !== null || pageRowRequested
                || await scrollToMessage(targetMessageId, { behavior: 'auto' }).catch(() => false);
            if (!isCurrent() || !scrollNode) return;
            if (!scrolled && !mounted) return;
            let steps = 0;
            const tryReveal = () => {
                frame = null;
                if (!isCurrent()) { cancel(); return; }
                const pageRoot = anchor.page ? findUiRenderQuoteRoot(scrollNode, messageId, anchor.page.partId) : null;
                const roots = anchor.page ? pageRoot ? [pageRoot] : [] : findChatQuoteRoots(scrollNode, messageId);
                if (anchor.page?.kind === 'ui' && roots.length === 0 && !pageRowRequested && scrollToUiPageRowRef.current?.(messageId)) {
                    pageRowRequested = true;
                    return;
                }
                if (roots.length === 0 || roots.some((root) => root.querySelector('[data-chat-quote-pending]'))) return;
                const parts = resolveChatQuoteRanges(roots, anchor);
                if (!parts && steps < REVEAL_ATTEMPTS && messageContinuesBelow(scrollNode, targetMessageId)) {
                    dispatchNavigationRelease(scrollNode);
                    scrollToNextSlice(scrollNode, targetMessageId);
                    steps += 1;
                    return;
                }
                cancel();
                if (!parts) return;
                parts[0].startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
                if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
                paintFlash(parts);
                flashTimerRef.current = window.setTimeout(() => {
                    flashTimerRef.current = null;
                    paintFlash([]);
                }, FLASH_DURATION_MS);
            };
            const selector = `[data-message-id="${CSS.escape(targetMessageId)}"]`;
            const pageSelector = anchor.page?.kind === 'ui'
                ? `[data-ui-render-message="${CSS.escape(messageId)}"][data-ui-render-part="${CSS.escape(anchor.page.partId)}"]`
                : null;
            observer = new MutationObserver((records) => {
                if (frame !== null) return;
                const relevant = records.some((record) => {
                    const element = record.target instanceof Element ? record.target : record.target.parentElement;
                    if (pageSelector && element?.closest(pageSelector)) return true;
                    const message = element?.closest('[data-message-id]');
                    if (message?.getAttribute('data-message-id') === targetMessageId) return true;
                    return [...record.addedNodes].some((node) => node instanceof Element
                        && (node.matches(selector) || node.querySelector(selector)
                            || (pageSelector && (node.matches(pageSelector) || node.querySelector(pageSelector)))));
                });
                if (relevant) frame = window.requestAnimationFrame(tryReveal);
            });
            observer.observe(scrollNode, { childList: true, subtree: true, characterData: true });
            tryReveal();
        })().finally(() => { if (!observer) cancel(); });
    }, [paintFlash]);

    React.useEffect(() => {
        store.setRevealHandler(reveal);
        return () => {
            revealGenerationRef.current += 1;
            store.setRevealHandler(null);
        };
    }, [reveal, store]);

    const openMark = popover ? marks.find((mark) => mark.id === popover.markId) ?? null : null;
    const editingRef = React.useRef(editing);
    editingRef.current = editing;
    const popoverRef = React.useRef(popover);
    popoverRef.current = popover;
    const openTimerRef = React.useRef<number | null>(null);
    const closeTimerRef = React.useRef<number | null>(null);
    const popoverElementRef = React.useRef<HTMLDivElement>(null);

    const isInPopoverCorridor = React.useCallback((x: number, y: number): boolean => {
        const open = popoverRef.current;
        const parts = open ? rangesRef.current.get(open.markId) : null;
        const box = popoverElementRef.current?.getBoundingClientRect();
        if (!parts || !box) return false;
        const mark = boundsOf(parts);
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

    React.useEffect(() => onPageMarkClick((click) => {
        if (!click.markId) {
            if (popoverRef.current?.measure && !editingRef.current) closePopover();
            return;
        }
        if (!marksRef.current.some((mark) => mark.id === click.markId && mark.anchor.page?.partId === click.partId)) return;
        if (popoverRef.current?.markId === click.markId) {
            closePopover();
            return;
        }
        clearTimers();
        setEditing(false);
        setPopover({ markId: click.markId, rect: click.measure(), measure: click.measure, portal: click.portalTarget });
    }), [clearTimers, closePopover]);

    const showPopover = React.useCallback((markId: string) => {
        const parts = rangesRef.current.get(markId);
        if (!parts) return;
        setPopover({ markId, rect: boundsOf(parts) });
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

    const openMarkId = popover?.markId ?? null;
    React.useEffect(() => {
        if (!openMarkId) return;
        let frame: number | null = null;
        const follow = () => {
            if (frame !== null) return;
            frame = window.requestAnimationFrame(() => {
                frame = null;
                const parts = rangesRef.current.get(openMarkId);
                const rect = parts ? boundsOf(parts) : popoverRef.current?.measure?.();
                if (!rect) {
                    closePopover();
                    return;
                }
                setPopover((current) => (current && current.markId === openMarkId ? { ...current, rect } : current));
            });
        };
        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse' || editingRef.current || popoverRef.current?.measure) return;
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
            portalTarget={popover.portal}
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
