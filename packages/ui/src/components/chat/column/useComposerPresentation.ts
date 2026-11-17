import React from 'react';
import {
    forgetComposerSlot,
    recordComposerSlotHeight,
} from '@/components/chat/composer/state/composerTailInset';
import {
    publishComposerInsets,
    withdrawComposerInsets,
} from '@/components/chat/composer/state/composerInsetReaders';

const DRAFT_EXIT_DURATION_MS = 120;
const COMPOSER_MOVE_DURATION_MS = 180;

export const useComposerPresentation = ({
    currentSessionId,
    materializedDraftSessionId,
    draftOpen,
    isDesktopExpandedInput,
    useCompactDraftLayout,
    clearMaterializedDraftSession,
}: {
    currentSessionId: string | null;
    materializedDraftSessionId: string | null;
    draftOpen: boolean;
    isDesktopExpandedInput: boolean;
    useCompactDraftLayout: boolean;
    clearMaterializedDraftSession: (sessionId: string) => void;
}) => {
    const composerSlotRef = React.useRef<HTMLDivElement | null>(null);
    const [composerSlotNode, setComposerSlotNode] = React.useState<HTMLDivElement | null>(null);
    const attachComposerSlot = React.useCallback((node: HTMLDivElement | null) => {
        composerSlotRef.current = node;
        setComposerSlotNode(node);
    }, []);
    const previousComposerRectRef = React.useRef<DOMRect | null>(null);
    const previousDraftOpenRef = React.useRef(draftOpen);
    const previousDraftLayoutVisibleRef = React.useRef(draftOpen);
    const [draftExitAnimating, setDraftExitAnimating] = React.useState(false);
    const shouldAnimateDraftTransition = Boolean(
        currentSessionId && materializedDraftSessionId === currentSessionId,
    );
    const draftPresentationExiting = draftExitAnimating
        || (previousDraftOpenRef.current && !draftOpen && shouldAnimateDraftTransition);
    const draftLayoutVisible = draftOpen || draftPresentationExiting;
    const floatingComposer = !draftLayoutVisible && !isDesktopExpandedInput;
    React.useLayoutEffect(() => {
        const slot = composerSlotNode;
        const column = slot?.parentElement;
        if (!floatingComposer || !slot || !column || !globalThis.ResizeObserver) return;
        const update = () => {
            const height = Math.round(slot.getBoundingClientRect().height);
            const transient = slot.style.height !== '' || slot.querySelector('[data-composer-transient]') !== null;
            const { tailInset, grown } = recordComposerSlotHeight(column, height, !transient);
            publishComposerInsets(column, { inset: height, tailInset });
            column.toggleAttribute('data-composer-grown', grown);
        };
        const observer = new ResizeObserver(update);
        observer.observe(slot);
        update();
        return () => {
            observer.disconnect();
            forgetComposerSlot(column);
            withdrawComposerInsets(column);
            column.removeAttribute('data-composer-grown');
        };
    }, [composerSlotNode, floatingComposer]);

    React.useLayoutEffect(() => {
        if (draftOpen) {
            setDraftExitAnimating(false);
            return;
        }
        if (!previousDraftOpenRef.current || !shouldAnimateDraftTransition) return;

        setDraftExitAnimating(true);
        const timeoutId = window.setTimeout(() => setDraftExitAnimating(false), DRAFT_EXIT_DURATION_MS);
        return () => window.clearTimeout(timeoutId);
    }, [draftOpen, shouldAnimateDraftTransition]);

    React.useLayoutEffect(() => {
        previousDraftOpenRef.current = draftOpen;
    }, [draftOpen]);

    React.useLayoutEffect(() => {
        const composerSlot = composerSlotRef.current;
        if (!composerSlot) return;

        const composerEditor = composerSlot.querySelector('[data-testid="chat-input"]');
        const currentRect = composerEditor?.getBoundingClientRect() ?? composerSlot.getBoundingClientRect();
        const previousRect = previousComposerRectRef.current;
        const leftDraftLayout = previousDraftLayoutVisibleRef.current
            && !draftLayoutVisible
            && Boolean(currentSessionId);
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

        const shouldMoveComposer = leftDraftLayout && shouldAnimateDraftTransition;
        if (shouldMoveComposer && previousRect && !reduceMotion && !useCompactDraftLayout && !isDesktopExpandedInput) {
            const deltaX = previousRect.left - currentRect.left;
            const deltaY = previousRect.top - currentRect.top;
            composerSlot.animate(
                [
                    { transform: `translate(${deltaX}px, ${deltaY}px)` },
                    { transform: 'translate(0, 0)' },
                ],
                { duration: COMPOSER_MOVE_DURATION_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
            );
        }
        previousComposerRectRef.current = currentRect;
        previousDraftLayoutVisibleRef.current = draftLayoutVisible;
        if (leftDraftLayout && currentSessionId) {
            clearMaterializedDraftSession(currentSessionId);
        }
    }, [
        clearMaterializedDraftSession,
        currentSessionId,
        draftLayoutVisible,
        isDesktopExpandedInput,
        shouldAnimateDraftTransition,
        useCompactDraftLayout,
    ]);

    return { attachComposerSlot, draftPresentationExiting, draftLayoutVisible, floatingComposer };
};
