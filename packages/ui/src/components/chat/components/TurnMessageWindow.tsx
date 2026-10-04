import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import {
    TURN_MESSAGE_REVEAL_CHUNK,
    TurnMessageWindowContext,
    FULL_MESSAGE_WINDOW,
    initialMessageWindow,
    shouldHoldRevealAnchor,
    type TurnMessageWindowRange,
} from '../lib/turns/turnMessageWindow';
import { TIMELINE_FOLLOW_REARM_THRESHOLD_PX } from '../lib/scroll/timelineScrollAnchoring';

// Stands in for a not yet mounted message until it mounts and measures.
const ESTIMATED_MESSAGE_HEIGHT_PX = 64;
const CHAT_SCROLLER_SELECTOR = '[data-scrollbar="chat"]';

// Not wheel: a trackpad sends wheel events for as long as a scroll and its
// momentum last, so a wheel-ended hold lasted one frame and the list's later
// correction threw the reader by the whole batch. The hold is two frames.
const READER_INPUT_EVENTS = ['touchstart', 'pointerdown', 'keydown'] as const;

const subscribeNowhere = () => () => {};

/** Whether the chat timeline holding `element` is scrolled to its end. */
export const isReaderAtTimelineEnd = (element: Element): boolean => {
    const scroller = element.closest(CHAT_SCROLLER_SELECTOR);
    if (!scroller) return false;
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
};

/**
 * Keeps the message the reader is looking at where it was across a batch
 * mount. The list measures the grown row after this commit and, anchored to
 * a visible row it can have cached from before the reader scrolled into this
 * turn, may move the viewport by the same amount a second time. Observed
 * after the list's own measurement, the resize check puts the message back
 * before that frame paints; the frame checks cover a later correction. Touch,
 * pointer or key input ends the hold at once.
 */
const holdAnchor = (scroller: Element, element: Element, top: number): (() => void) => {
    const align = () => {
        if (!element.isConnected) return;
        const delta = element.getBoundingClientRect().top - top;
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
    };
    const resizeObserver = new ResizeObserver(align);
    let frame: number | null = null;
    const stop = () => {
        resizeObserver.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        for (const type of READER_INPUT_EVENTS) scroller.removeEventListener(type, stop);
    };
    align();
    resizeObserver.observe(element.closest('[data-turn-id]') ?? element);
    for (const type of READER_INPUT_EVENTS) scroller.addEventListener(type, stop, { passive: true });
    frame = requestAnimationFrame(() => {
        align();
        frame = requestAnimationFrame(() => {
            align();
            stop();
        });
    });
    return stop;
};

/**
 * Mounts the next batch once a spacer comes within a viewport of the
 * visible area; a spacer already on screen mounts everything it holds, since
 * a reader looking at it would otherwise watch it fill batch by batch.
 * Observed afresh after every batch: a new observation reports the current
 * intersection, so a spacer still near the viewport keeps going.
 */
const useSpacerReveal = (
    spacerRef: React.RefObject<HTMLDivElement | null>,
    hidden: number,
    reveal: (nextHidden: number) => void,
) => {
    React.useEffect(() => {
        const spacer = spacerRef.current;
        const scroller = spacer?.closest(CHAT_SCROLLER_SELECTOR);
        if (!spacer || !scroller) return;
        const observer = new IntersectionObserver((entries) => {
            if (!entries[entries.length - 1]?.isIntersecting) return;
            const view = scroller.getBoundingClientRect();
            const rect = spacer.getBoundingClientRect();
            const onScreen = rect.bottom > view.top && rect.top < view.bottom;
            reveal(onScreen ? 0 : Math.max(0, hidden - TURN_MESSAGE_REVEAL_CHUNK));
        }, { root: scroller, rootMargin: '100% 0px' });
        observer.observe(spacer);
        return () => observer.disconnect();
    }, [hidden, reveal, spacerRef]);
};

interface TurnMessageWindowProps {
    turnId: string;
    messages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

/**
 * A turn's assistant messages, with the steps of a long turn outside its
 * window held behind spacers until they come near the viewport (see
 * turnMessageWindow). Mounting a batch above the reader keeps the message
 * they were looking at still.
 */
export function TurnMessageWindow({ turnId, messages, renderMessage }: TurnMessageWindowProps) {
    const store = React.useContext(TurnMessageWindowContext);
    const [initialRange] = React.useState(() => store?.range(turnId) ?? initialMessageWindow(messages.length));
    const storedRange = React.useSyncExternalStore(
        store?.subscribe ?? subscribeNowhere,
        () => store?.range(turnId),
    );
    const range: TurnMessageWindowRange = store ? storedRange ?? initialRange : FULL_MESSAGE_WINDOW;
    const hiddenHead = Math.min(range.hiddenHead, messages.length);
    const hiddenTail = Math.min(range.hiddenTail, messages.length - hiddenHead);

    const headSpacerRef = React.useRef<HTMLDivElement | null>(null);
    const tailSpacerRef = React.useRef<HTMLDivElement | null>(null);
    const anchorRef = React.useRef<{ element: Element; top: number } | null>(null);

    React.useLayoutEffect(() => {
        if (store && store.range(turnId) === undefined) store.setRange(turnId, initialRange);
    }, [initialRange, store, turnId]);

    const revealHead = React.useCallback((nextHidden: number) => {
        const spacer = headSpacerRef.current;
        const scroller = spacer?.closest(CHAT_SCROLLER_SELECTOR);
        const firstMounted = spacer?.nextElementSibling;
        anchorRef.current = null;
        if (spacer && scroller && firstMounted) {
            const view = scroller.getBoundingClientRect();
            const top = firstMounted.getBoundingClientRect().top;
            if (shouldHoldRevealAnchor({
                spacerTop: spacer.getBoundingClientRect().top,
                firstMountedTop: top,
                viewTop: view.top,
                viewBottom: view.bottom,
            })) {
                anchorRef.current = { element: firstMounted, top };
            }
        }
        const current = store?.range(turnId) ?? FULL_MESSAGE_WINDOW;
        store?.setRange(turnId, { ...current, hiddenHead: nextHidden });
    }, [store, turnId]);

    const revealTail = React.useCallback((nextHidden: number) => {
        const current = store?.range(turnId) ?? FULL_MESSAGE_WINDOW;
        store?.setRange(turnId, { ...current, hiddenTail: nextHidden });
    }, [store, turnId]);

    React.useLayoutEffect(() => {
        const anchor = anchorRef.current;
        anchorRef.current = null;
        if (!anchor?.element.isConnected) return;
        const scroller = anchor.element.closest(CHAT_SCROLLER_SELECTOR);
        if (!scroller) return;
        return holdAnchor(scroller, anchor.element, anchor.top);
    }, [hiddenHead]);

    useSpacerReveal(headSpacerRef, hiddenHead, revealHead);
    useSpacerReveal(tailSpacerRef, hiddenTail, revealTail);

    const visibleMessages = hiddenHead > 0 || hiddenTail > 0
        ? messages.slice(hiddenHead, messages.length - hiddenTail)
        : messages;
    return (
        <>
            {hiddenHead > 0 ? (
                <div
                    ref={headSpacerRef}
                    aria-hidden="true"
                    data-turn-message-spacer="head"
                    style={{ height: hiddenHead * ESTIMATED_MESSAGE_HEIGHT_PX }}
                />
            ) : null}
            {visibleMessages.map((message) => renderMessage(message))}
            {hiddenTail > 0 ? (
                <div
                    ref={tailSpacerRef}
                    aria-hidden="true"
                    data-turn-message-spacer="tail"
                    style={{ height: hiddenTail * ESTIMATED_MESSAGE_HEIGHT_PX }}
                />
            ) : null}
        </>
    );
}
