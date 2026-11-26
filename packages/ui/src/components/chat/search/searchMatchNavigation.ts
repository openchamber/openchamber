import { readMessageFocusInFlight, requestMessageFocus } from '@/lib/router/messageFocus';
import { onEachFrame } from '@/lib/timing/onEachFrame';

import { messageLinkOffsetTop } from '../lib/scroll/messageViewportAnchor';
import { dispatchNavigationRelease, onFrameScroll } from '../lib/scroll/timelineScrollIntent';
import { findTermRanges } from './chatSearchHighlight';

export type SearchTarget = { readonly messageId: string; readonly reasoning: boolean };

export type MatchLocator = { readonly key: string; readonly part: string | null; readonly row: number; readonly order: number };

export type MatchPlace =
    | { readonly kind: 'last'; readonly index: number }
    | { readonly kind: 'index'; readonly index: number }
    | { readonly kind: 'shown'; readonly index: number; readonly locator: MatchLocator }
    | { readonly kind: 'next' | 'previous'; readonly index: number; readonly from: MatchLocator };

type Match = { readonly range: Range; readonly locator: MatchLocator };

type MessageRow = { readonly element: HTMLElement; readonly index: number; readonly count: number; readonly rect: DOMRect };

type Scan = {
    row: number | null;
    readonly step: 1 | -1;
    skip: number;
    anchor: { readonly locator: MatchLocator; readonly past: 0 | 1 } | null;
    seen: MatchLocator | null;
};

type NextMove =
    | { readonly kind: 'show'; readonly match: Match }
    | { readonly kind: 'walk'; readonly toward: 'below' | 'above'; readonly from: MessageRow }
    | { readonly kind: 'focus' | 'pending' | 'unmounted' | 'none' };

const MAX_PENDING_MS = 15_000;
const MAX_STALL_MS = 2_000;
const MAX_FOCUS_SETTLE_MS = 3_000;
const SETTLE_FRAMES = 6;
const MAX_HOLD_FRAMES = 120;
const COMPOSER_GAP_PX = 12;

export const searchTargetKey = (target: SearchTarget): string => `${target.reasoning ? 'r' : 'm'}:${target.messageId}`;

const sameMatch = (left: MatchLocator, right: MatchLocator): boolean => (
    left.key === right.key && left.part === right.part && left.order === right.order
);

const mountedRows = (scrollNode: HTMLElement, target: SearchTarget): MessageRow[] => (
    [...scrollNode.querySelectorAll<HTMLElement>(`[data-message-id="${CSS.escape(target.messageId)}"]:not([data-message-hoisted])`)]
        .map((element) => {
            const [index, count] = (element.getAttribute('data-message-row') ?? '0/1').split('/').map(Number);
            return { element, index, count, rect: element.getBoundingClientRect() };
        })
        .sort((left, right) => left.index - right.index || left.rect.top - right.rect.top)
);

const reasoningBlocks = (row: MessageRow, target: SearchTarget): HTMLElement[] => (
    [...row.element.querySelectorAll<HTMLElement>(`[data-reasoning-message-id="${CSS.escape(target.messageId)}"]`)]
);

export const rowPartName = (row: Element): string | null => (
    row.getAttribute('data-message-slice') ?? row.getAttribute('data-reasoning-block-id')
);

const listMatches = (rows: readonly MessageRow[], target: SearchTarget, terms: readonly string[]): Match[] => {
    const key = searchTargetKey(target);
    return rows.flatMap((row) => (target.reasoning ? reasoningBlocks(row, target) : [row.element]).flatMap((root) => {
        const part = rowPartName(root);
        return findTermRanges(root, terms).map((range, order) => ({ range, locator: { key, part, row: row.index, order } }));
    }));
};

const isScrollBox = (element: HTMLElement): boolean => (
    element.scrollHeight > element.clientHeight && /(auto|scroll)/.test(getComputedStyle(element).overflowY)
);

const scrollTo = (box: HTMLElement, distance: number): boolean => {
    if (Math.abs(distance) <= 1) return false;
    const before = box.scrollTop;
    box.scrollTop += distance;
    return Math.abs(box.scrollTop - before) > 0.5;
};

const middleOf = (rect: DOMRect): number => rect.top + rect.height / 2;

const visibleMiddle = (scrollNode: HTMLElement): number => {
    const bounds = scrollNode.getBoundingClientRect();
    const composer = scrollNode.closest('[data-composer-bound]')?.querySelector('[data-composer-slot="floating"]')?.getBoundingClientRect();
    const top = bounds.top + messageLinkOffsetTop(scrollNode);
    const bottom = Math.min(bounds.bottom, composer?.top ?? bounds.bottom) - COMPOSER_GAP_PX;
    return bottom > top ? (top + bottom) / 2 : middleOf(bounds);
};

const shownRect = (scrollNode: HTMLElement, range: Range): DOMRect => {
    let rect = range.getBoundingClientRect();
    for (let box = range.startContainer.parentElement; box && box !== scrollNode && scrollNode.contains(box); box = box.parentElement) {
        const bounds = box.getBoundingClientRect();
        const collapsed = rect.width === 0 && rect.height === 0;
        const clipped = /(auto|scroll|hidden|clip)/.test(getComputedStyle(box).overflowY)
            && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
        if (collapsed || clipped) rect = bounds;
    }
    return rect;
};

const centerRange = (scrollNode: HTMLElement, range: Range): boolean => {
    let moved = false;
    for (let box = range.startContainer.parentElement; box && box !== scrollNode && scrollNode.contains(box); box = box.parentElement) {
        if (isScrollBox(box)) moved = scrollTo(box, middleOf(range.getBoundingClientRect()) - middleOf(box.getBoundingClientRect())) || moved;
    }
    return scrollTo(scrollNode, middleOf(shownRect(scrollNode, range)) - visibleMiddle(scrollNode)) || moved;
};

const walkPast = (scrollNode: HTMLElement, from: MessageRow, toward: 'below' | 'above'): void => {
    const bounds = scrollNode.getBoundingClientRect();
    scrollNode.scrollTop += toward === 'below' ? from.rect.bottom - bounds.top : from.rect.top - bounds.bottom;
};

const startScan = (place: MatchPlace): Scan => {
    switch (place.kind) {
        case 'index': return { row: 0, step: 1, skip: place.index, anchor: null, seen: null };
        case 'shown': return { row: place.locator.row, step: 1, skip: 0, anchor: { locator: place.locator, past: 0 }, seen: null };
        case 'last': return { row: null, step: -1, skip: 0, anchor: null, seen: null };
        case 'next':
        case 'previous':
            return { row: place.from.row, step: place.kind === 'next' ? 1 : -1, skip: 0, anchor: { locator: place.from, past: 1 }, seen: null };
    }
};

const walkToward = (rows: readonly MessageRow[], wanted: number): NextMove => {
    const above = rows.filter((row) => row.index < wanted).at(-1);
    if (above) return { kind: 'walk', toward: 'below', from: above };
    const below = rows.find((row) => row.index > wanted);
    return below ? { kind: 'walk', toward: 'above', from: below } : { kind: 'unmounted' };
};

const createMatchScan = (place: MatchPlace, target: SearchTarget, terms: readonly string[]) => {
    let scan = startScan(place);
    let recounted = false;

    const advance = (rows: readonly MessageRow[]): NextMove => {
        const count = Math.max(...rows.map((row) => row.count));
        if (scan.anchor && (scan.row === null || scan.row < 0 || scan.row >= count)) {
            if (recounted) return { kind: 'none' };
            recounted = true;
            scan = startScan({ kind: 'index', index: place.index });
            return advance(rows);
        }
        for (let wanted = scan.row ?? count - 1; wanted >= 0 && wanted < count; wanted += scan.step) {
            scan.row = wanted;
            const here = rows.filter((row) => row.index === wanted);
            if (here.length === 0) return walkToward(rows, wanted);
            if (here.some((row) => row.element.querySelector('[data-chat-quote-pending]'))) return { kind: 'pending' };
            const matches = listMatches(here, target, terms);
            if (scan.anchor) {
                const { locator, past } = scan.anchor;
                const at = matches.findIndex((match) => sameMatch(match.locator, locator));
                if (at < 0) {
                    if (recounted) return { kind: 'none' };
                    recounted = true;
                    scan = startScan({ kind: 'index', index: place.index });
                    return advance(rows);
                }
                scan.skip = past + (scan.step > 0 ? at : matches.length - 1 - at);
                scan.anchor = null;
            }
            const match = matches[scan.step > 0 ? scan.skip : matches.length - 1 - scan.skip];
            if (match) return { kind: 'show', match };
            scan.seen = matches.at(scan.step > 0 ? -1 : 0)?.locator ?? scan.seen;
            scan.skip -= matches.length;
        }
        if (!scan.seen) return { kind: 'none' };
        const locator = scan.seen;
        scan = { row: locator.row, step: 1, skip: 0, anchor: { locator, past: 0 }, seen: null };
        return advance(rows);
    };

    return advance;
};

const onReaderInput = (scrollNode: HTMLElement, listener: () => void): (() => void) => {
    const page = scrollNode.ownerDocument;
    const onPageInput = (event: Event) => {
        if (event.target instanceof Element && event.target.closest('[role="search"]')) return;
        listener();
    };
    const scrollerEvents = ['wheel', 'touchstart'] as const;
    const pageEvents = ['pointerdown', 'keydown'] as const;
    for (const event of scrollerEvents) scrollNode.addEventListener(event, listener, { passive: true });
    for (const event of pageEvents) page.addEventListener(event, onPageInput, { capture: true, passive: true });
    const stopFrameScroll = onFrameScroll(scrollNode, listener);
    return () => {
        for (const event of scrollerEvents) scrollNode.removeEventListener(event, listener);
        for (const event of pageEvents) page.removeEventListener(event, onPageInput, { capture: true });
        stopFrameScroll();
    };
};

export const showSearchMatch = ({
    scrollNode,
    sessionId,
    target,
    terms,
    place,
    takeViewport,
    onShown,
    onNotFound,
    onInterrupted,
}: {
    scrollNode: HTMLElement;
    sessionId: string;
    target: SearchTarget;
    terms: readonly string[];
    place: MatchPlace;
    takeViewport: () => void;
    onShown: (locator: MatchLocator) => void;
    onNotFound: () => void;
    onInterrupted: () => void;
}): (() => void) => {
    const advance = createMatchScan(place, target, terms);
    let focusAsked = false;
    let scanning = false;
    let progressAt = performance.now();
    let progress = '';
    let shown: MatchLocator | null = null;
    let settledFrames = 0;
    let holdFrames = 0;
    let stopFrames = () => {};
    let stopInput = () => {};

    const stop = () => {
        stopFrames();
        stopInput();
    };
    const claimViewport = () => {
        takeViewport();
        dispatchNavigationRelease(scrollNode);
    };
    const interrupt = () => {
        stop();
        if (shown) return;
        if (focusAsked) claimViewport();
        onInterrupted();
    };
    const askFocus = () => {
        focusAsked = true;
        progressAt = performance.now();
        requestMessageFocus(sessionId, target.messageId);
    };
    const giveUp = (): false => {
        stop();
        askFocus();
        onNotFound();
        return false;
    };
    const within = (limit: number): boolean => performance.now() - progressAt <= limit || giveUp();

    const holdShownInMiddle = (locator: MatchLocator): boolean => {
        const range = listMatches(mountedRows(scrollNode, target), target, terms).find((match) => sameMatch(match.locator, locator))?.range;
        if (!range) return false;
        settledFrames = centerRange(scrollNode, range) ? 0 : settledFrames + 1;
        holdFrames += 1;
        return settledFrames < SETTLE_FRAMES && holdFrames < MAX_HOLD_FRAMES;
    };

    const nextMove = (rows: readonly MessageRow[]): NextMove => {
        if (scanning) return rows.length === 0 ? { kind: 'unmounted' } : advance(rows);
        const foldedAway = target.reasoning && !rows.some((row) => reasoningBlocks(row, target).length > 0);
        if (!focusAsked && (rows.length === 0 || foldedAway)) return { kind: 'focus' };
        if (rows.length === 0) return { kind: 'unmounted' };
        scanning = true;
        return advance(rows);
    };

    const tick = (): boolean => {
        if (shown) {
            if (holdShownInMiddle(shown)) return true;
            stop();
            return false;
        }
        const rows = mountedRows(scrollNode, target);
        if (focusAsked && readMessageFocusInFlight(sessionId) === target.messageId) {
            if (rows.length === 0) progressAt = performance.now();
            if (performance.now() - progressAt <= MAX_FOCUS_SETTLE_MS) return true;
        }
        const move = nextMove(rows);
        switch (move.kind) {
            case 'show':
                claimViewport();
                shown = move.match.locator;
                onShown(move.match.locator);
                centerRange(scrollNode, move.match.range);
                return true;
            case 'walk': {
                const reached = `${move.from.index}:${Math.round(scrollNode.scrollTop)}`;
                if (reached !== progress) progressAt = performance.now();
                progress = reached;
                if (!within(MAX_STALL_MS)) return false;
                claimViewport();
                walkPast(scrollNode, move.from, move.toward);
                return true;
            }
            case 'focus':
                askFocus();
                return true;
            case 'pending':
                return within(MAX_PENDING_MS);
            case 'unmounted':
                return within(MAX_STALL_MS);
            case 'none':
                return giveUp();
        }
    };

    stopInput = onReaderInput(scrollNode, interrupt);
    stopFrames = onEachFrame(tick);
    return stop;
};
