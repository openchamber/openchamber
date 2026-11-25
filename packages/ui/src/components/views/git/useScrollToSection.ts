import React from 'react';

import { afterDelay } from '@/lib/timing/afterDelay';
import { ALIGN_EPSILON_PX, SETTLE_MAX_MS, SETTLE_QUIET_MS, listenToHeldScroller } from '../diffView/heldScroller';

function scrollContainerOf(node: HTMLElement) {
    let parent = node.parentElement;
    while (parent) {
        const { overflowY } = window.getComputedStyle(parent);
        if (overflowY === 'auto' || overflowY === 'scroll') return parent;
        parent = parent.parentElement;
    }
    return null;
}

export function useScrollToSection() {
    const nodesRef = React.useRef(new Map<string, HTMLElement>());
    const pendingRef = React.useRef<string | null>(null);
    const holdRef = React.useRef<(() => void) | null>(null);
    const heldKeyRef = React.useRef<string | null>(null);
    const [request, setRequest] = React.useState<{ key: string } | null>(null);

    const holdAt = React.useCallback((key: string, node: HTMLElement) => {
        holdRef.current?.();
        const scrollParent = scrollContainerOf(node);
        const inputTarget = scrollParent?.parentElement ?? scrollParent ?? node;
        const content = node.closest('[data-diff-virtual-content]') ?? scrollParent?.firstElementChild ?? node.parentElement ?? node;
        let stopped = false;
        let stopListening: (() => void) | null = null;
        let frame: number | null = null;
        let cancelQuiet: (() => void) | null = null;
        let cancelDeadline: (() => void) | null = null;

        const cancelFrame = () => {
            if (frame === null) return;
            window.cancelAnimationFrame(frame);
            frame = null;
        };

        const stop = () => {
            if (stopped) return;
            stopped = true;
            cancelFrame();
            cancelQuiet?.();
            cancelDeadline?.();
            stopListening?.();
            if (holdRef.current === stop) {
                holdRef.current = null;
                heldKeyRef.current = null;
            }
        };
        const alignedOffset = () => {
            if (!scrollParent) return 0;
            return node.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top;
        };
        const align = () => {
            if (stopped) return;
            if (!node.isConnected) {
                stop();
                return;
            }
            if (scrollParent) {
                const offset = alignedOffset();
                if (Math.abs(offset) > ALIGN_EPSILON_PX) scrollParent.scrollTop += offset;
            } else {
                node.scrollIntoView({ block: 'start' });
            }
            cancelQuiet?.();
            cancelQuiet = afterDelay(SETTLE_QUIET_MS, stop);
        };
        const scheduleAlign = () => {
            cancelFrame();
            frame = window.requestAnimationFrame(align);
        };
        stopListening = listenToHeldScroller({ scroller: scrollParent, inputTarget, content, onMoved: scheduleAlign, onReaderInput: stop });
        cancelDeadline = afterDelay(SETTLE_MAX_MS, stop);
        holdRef.current = stop;
        heldKeyRef.current = key;
        align();
    }, []);

    React.useLayoutEffect(() => {
        if (!request) return;
        const node = nodesRef.current.get(request.key);
        if (node) {
            pendingRef.current = null;
            holdAt(request.key, node);
        } else {
            pendingRef.current = request.key;
        }
        return () => holdRef.current?.();
    }, [holdAt, request]);

    const scrollTo = React.useCallback((key: string) => {
        setRequest({ key });
    }, []);

    const registerSectionRef = React.useCallback((key: string, node: HTMLElement | null) => {
        if (!node) {
            nodesRef.current.delete(key);
            if (heldKeyRef.current === key) holdRef.current?.();
            return;
        }
        const previous = nodesRef.current.get(key);
        nodesRef.current.set(key, node);
        if (pendingRef.current === key || (heldKeyRef.current === key && previous !== node)) {
            pendingRef.current = null;
            holdAt(key, node);
        }
    }, [holdAt]);

    const cancel = React.useCallback(() => {
        holdRef.current?.();
        pendingRef.current = null;
        setRequest(null);
    }, []);

    return { registerSectionRef, scrollTo, cancel };
}
