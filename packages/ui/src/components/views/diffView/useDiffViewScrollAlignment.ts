import React from 'react';

import { afterDelay } from '@/lib/timing/afterDelay';
import { ALIGN_EPSILON_PX, SETTLE_MAX_MS, SETTLE_QUIET_MS, listenToHeldScroller } from './heldScroller';

interface DiffViewScrollAlignmentOptions {
    getFileSection: (path: string) => HTMLDivElement | null | undefined;
    diffScrollRef: React.RefObject<HTMLElement | null>;
    diffContentRef: React.RefObject<HTMLDivElement | null>;
    pendingScrollTargetRef: React.RefObject<string | null>;
    shouldPinAfterAlignRef: React.RefObject<boolean>;
    setPinnedStackedTarget: React.Dispatch<React.SetStateAction<string | null>>;
    pendingScrollFrameRef: React.RefObject<number | null>;
    scrollRequestNonce: number;
    requestContextKey: string;
    comparisonKey: string | null;
    visible: boolean;
    pinSelectedFileHeaderToTopOnNavigate: boolean;
}

export function useDiffViewScrollAlignment({
    getFileSection, diffScrollRef, diffContentRef, pendingScrollTargetRef, visible,
    shouldPinAfterAlignRef, setPinnedStackedTarget, pendingScrollFrameRef, pinSelectedFileHeaderToTopOnNavigate,
    scrollRequestNonce, requestContextKey, comparisonKey,
}: DiffViewScrollAlignmentOptions) {
    const requestContextKeyRef = React.useRef(requestContextKey);
    requestContextKeyRef.current = requestContextKey;
    const requestStartedContextKeyRef = React.useRef(requestContextKey);

    const comparisonKeyRef = React.useRef(comparisonKey);
    comparisonKeyRef.current = comparisonKey;
    const heldComparisonRef = React.useRef<{ nonce: number; key: string | null } | null>(null);

    const scrollToFile = React.useCallback((path: string): boolean => {
        const node = getFileSection(path);
        const scrollRoot = diffScrollRef.current;
        if (!node || !scrollRoot) {
            return false;
        }

        const scrollOffset = node.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
        if (Math.abs(scrollOffset) <= ALIGN_EPSILON_PX) {
            return true;
        }
        scrollRoot.scrollTo({ top: scrollRoot.scrollTop + scrollOffset, behavior: 'auto' });
        return true;
    }, [getFileSection, diffScrollRef]);

    React.useEffect(() => {
        const target = pendingScrollTargetRef.current;
        if (!visible || !target) return;

        requestStartedContextKeyRef.current = requestContextKeyRef.current;
        if (heldComparisonRef.current?.nonce !== scrollRequestNonce) {
            heldComparisonRef.current = { nonce: scrollRequestNonce, key: comparisonKeyRef.current };
        }
        const held = heldComparisonRef.current;
        let listenedRoot: HTMLElement | null = null;
        let stopListening: (() => void) | null = null;
        let cancelled = false;
        let aligned = false;
        let cancelQuiet: (() => void) | null = null;
        let cancelDeadline: (() => void) | null = null;

        const cancelFrame = () => {
            if (pendingScrollFrameRef.current === null) return;
            window.cancelAnimationFrame(pendingScrollFrameRef.current);
            pendingScrollFrameRef.current = null;
        };

        const detach = () => {
            stopListening?.();
            stopListening = null;
            listenedRoot = null;
        };

        const attach = () => {
            const root = diffScrollRef.current;
            if (root === listenedRoot) return;
            detach();
            if (!root) return;
            listenedRoot = root;
            stopListening = listenToHeldScroller({
                scroller: root,
                inputTarget: root.parentElement ?? root,
                content: diffContentRef.current,
                onMoved: handleMoved,
                onReaderInput: finish,
            });
        };

        const teardown = () => {
            if (cancelled) return;
            cancelled = true;
            cancelFrame();
            cancelQuiet?.();
            cancelDeadline?.();
            cancelQuiet = null;
            cancelDeadline = null;
            detach();
        };

        const finish = () => {
            if (cancelled) return;
            pendingScrollTargetRef.current = null;
            shouldPinAfterAlignRef.current = false;
            setPinnedStackedTarget(null);
            teardown();
        };

        function handleMoved() {
            if (cancelled || !aligned) return;
            scheduleAlign();
        }

        const scheduleAlign = () => {
            cancelFrame();
            pendingScrollFrameRef.current = window.requestAnimationFrame(align);
        };

        const armQuietTimer = () => {
            cancelQuiet?.();
            cancelQuiet = afterDelay(SETTLE_QUIET_MS, finish);
        };

        function align() {
            pendingScrollFrameRef.current = null;
            if (cancelled) return;
            held.key ??= comparisonKeyRef.current;
            const otherComparison = comparisonKeyRef.current !== null && comparisonKeyRef.current !== held.key;
            if (otherComparison || requestContextKeyRef.current !== requestStartedContextKeyRef.current) {
                finish();
                return;
            }
            const currentTarget = pendingScrollTargetRef.current;
            if (!currentTarget) {
                finish();
                return;
            }
            attach();
            if (!scrollToFile(currentTarget)) {
                scheduleAlign();
                return;
            }
            if (!aligned) {
                aligned = true;
                if (pinSelectedFileHeaderToTopOnNavigate && shouldPinAfterAlignRef.current) {
                    setPinnedStackedTarget(currentTarget);
                }
            }
            armQuietTimer();
        }

        attach();
        cancelDeadline = afterDelay(SETTLE_MAX_MS, finish);
        scheduleAlign();

        return teardown;
    }, [diffContentRef, diffScrollRef, pinSelectedFileHeaderToTopOnNavigate, pendingScrollFrameRef, pendingScrollTargetRef, scrollRequestNonce, scrollToFile, setPinnedStackedTarget, shouldPinAfterAlignRef, visible]);

    return { scrollToFile };
}
