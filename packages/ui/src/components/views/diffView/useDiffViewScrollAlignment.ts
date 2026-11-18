import React from 'react';
interface DiffViewScrollAlignmentOptions {
    fileSectionRefs: React.RefObject<Map<string, HTMLDivElement | null>>;
    diffScrollRef: React.RefObject<HTMLElement | null>;
    pendingScrollTargetRef: React.RefObject<string | null>;
    shouldPinAfterAlignRef: React.RefObject<boolean>;
    setPinnedStackedTarget: React.Dispatch<React.SetStateAction<string | null>>;
    pendingScrollFrameRef: React.RefObject<number | null>;
    scrollRequestNonce: number;
    visible: boolean;
    pinSelectedFileHeaderToTopOnNavigate: boolean;
}

export function useDiffViewScrollAlignment({
    fileSectionRefs, diffScrollRef, pendingScrollTargetRef, visible,
    shouldPinAfterAlignRef, setPinnedStackedTarget, pendingScrollFrameRef, pinSelectedFileHeaderToTopOnNavigate,
    scrollRequestNonce,
}: DiffViewScrollAlignmentOptions) {
    const scrollToFile = React.useCallback((path: string): boolean => {
        const node = fileSectionRefs.current.get(path);
        const scrollRoot = diffScrollRef.current;
        if (!node || !scrollRoot) {
            return false;
        }

        const scrollOffset = node.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
        scrollRoot.scrollTo({ top: scrollRoot.scrollTop + scrollOffset, behavior: 'auto' });
        return true;
    }, []);

    React.useEffect(() => {
        const target = pendingScrollTargetRef.current;
        if (!visible || !target) return;

        let attempts = 0;
        const maxAttempts = 20;
        let cancelled = false;

        const cancelPending = (clearPinnedTarget = true) => {
            if (cancelled) {
                return;
            }
            cancelled = true;
            pendingScrollTargetRef.current = null;
            shouldPinAfterAlignRef.current = false;
            if (clearPinnedTarget) {
                setPinnedStackedTarget(null);
            }
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
        };

        const tryAlign = () => {
            if (cancelled) {
                pendingScrollFrameRef.current = null;
                return;
            }
            const currentTarget = pendingScrollTargetRef.current;
            if (!currentTarget) {
                cancelPending();
                pendingScrollFrameRef.current = null;
                return;
            }

            const result = scrollToFile(currentTarget);
            if (!result) {
                attempts += 1;
                if (attempts < maxAttempts) {
                    pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);
                } else {
                    cancelPending();
                    pendingScrollFrameRef.current = null;
                }
                return;
            }

            if (pinSelectedFileHeaderToTopOnNavigate && shouldPinAfterAlignRef.current) {
                setPinnedStackedTarget(currentTarget);
                cancelPending(false);
                return;
            }
            cancelPending();
        };

        pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);

        return () => {
            cancelled = true;
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
        };
    }, [pinSelectedFileHeaderToTopOnNavigate, scrollRequestNonce, scrollToFile, visible]);

    return { scrollToFile };
}
