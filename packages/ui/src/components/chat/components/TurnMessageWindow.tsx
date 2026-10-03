import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import {
    TURN_MESSAGE_REVEAL_CHUNK,
    TurnMessageWindowContext,
    initialHiddenMessageCount,
    shouldHoldRevealAnchor,
} from '../lib/turns/turnMessageWindow';

// Stands in for a not yet mounted message until it mounts and measures.
const ESTIMATED_MESSAGE_HEIGHT_PX = 64;
const CHAT_SCROLLER_SELECTOR = '[data-scrollbar="chat"]';

// Not wheel: a trackpad sends wheel events for as long as a scroll and its
// momentum last, so a wheel-ended hold lasted one frame and the list's later
// correction threw the reader by the whole batch. The hold is two frames.
const READER_INPUT_EVENTS = ['touchstart', 'pointerdown', 'keydown'] as const;

const subscribeNowhere = () => () => {};

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

interface TurnMessageWindowProps {
    turnId: string;
    messages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    // The reader asked for the whole turn (opened a settled activity fold).
    mountAll?: boolean;
}

/**
 * A turn's assistant messages, with the older messages of a long turn held
 * behind a spacer until they come near the viewport (see turnMessageWindow).
 * Mounting a batch above the reader keeps the message they were looking at
 * still; a spacer that is itself on screen mounts everything left at once,
 * since a reader looking at it would otherwise watch it fill batch by batch.
 */
export function TurnMessageWindow({ turnId, messages, renderMessage, mountAll = false }: TurnMessageWindowProps) {
    const store = React.useContext(TurnMessageWindowContext);
    const [initialHidden] = React.useState(() => store?.hiddenCount(turnId) ?? initialHiddenMessageCount(messages.length));
    const storedHidden = React.useSyncExternalStore(
        store?.subscribe ?? subscribeNowhere,
        () => store?.hiddenCount(turnId),
    );
    const hidden = store && !mountAll ? Math.min(storedHidden ?? initialHidden, messages.length) : 0;

    const spacerRef = React.useRef<HTMLDivElement | null>(null);
    const anchorRef = React.useRef<{ element: Element; top: number } | null>(null);

    React.useLayoutEffect(() => {
        if (store && store.hiddenCount(turnId) === undefined) store.setHiddenCount(turnId, initialHidden);
    }, [initialHidden, store, turnId]);

    const reveal = React.useCallback((nextHidden: number) => {
        const spacer = spacerRef.current;
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
        store?.setHiddenCount(turnId, nextHidden);
    }, [store, turnId]);

    React.useLayoutEffect(() => {
        const anchor = anchorRef.current;
        anchorRef.current = null;
        if (!anchor?.element.isConnected) return;
        const scroller = anchor.element.closest(CHAT_SCROLLER_SELECTOR);
        if (!scroller) return;
        return holdAnchor(scroller, anchor.element, anchor.top);
    }, [hidden]);

    // Observed afresh after every batch: a new observation reports the
    // current intersection, so a spacer still near the viewport keeps going.
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
    }, [hidden, reveal]);

    const visibleMessages = hidden > 0 ? messages.slice(hidden) : messages;
    return (
        <>
            {hidden > 0 ? (
                <div
                    ref={spacerRef}
                    aria-hidden="true"
                    data-turn-message-spacer=""
                    style={{ height: hidden * ESTIMATED_MESSAGE_HEIGHT_PX }}
                />
            ) : null}
            {visibleMessages.map((message) => renderMessage(message))}
        </>
    );
}
