import React from 'react';

interface ScrollableDiffViewer {
    scrollToLine: (target: { lineNumber: number; side: 'additions' | 'deletions'; align: 'center' }) => boolean;
}

interface ScrollToLineTargetOptions {
    viewerRef: React.RefObject<ScrollableDiffViewer | null>;
    target: { line: number; side: 'additions' | 'deletions'; nonce: number } | null;
    revision: unknown;
    onReached?: () => void;
}

const SCROLL_WAIT_MS = 5000;

export function useScrollToLineTarget({ viewerRef, target, revision, onReached }: ScrollToLineTargetOptions): void {
    const line = target?.line ?? null;
    const side = target?.side;
    const nonce = target?.nonce ?? 0;
    React.useEffect(() => {
        if (line === null || !side) return;
        const deadline = performance.now() + SCROLL_WAIT_MS;
        let frame = window.requestAnimationFrame(function attempt() {
            if (viewerRef.current?.scrollToLine({ lineNumber: line, side, align: 'center' })) {
                onReached?.();
                return;
            }
            if (performance.now() < deadline) frame = window.requestAnimationFrame(attempt);
            else onReached?.();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [line, nonce, onReached, revision, side, viewerRef]);
}
