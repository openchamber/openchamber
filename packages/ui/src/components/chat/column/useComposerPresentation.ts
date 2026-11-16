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

/**
 * Where the composer sits: the slot it renders in, whether it floats over the
 * transcript, the draft-to-session transition (the draft layout lingers while
 * it exits and the composer glides to its new place), and the insets the slot
 * publishes to the transcript.
 */
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
    // The slot mounts after the first commit (behind the session gate), so
    // the inset observer keys on the node itself rather than on mount.
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
    // The composer floats over the transcript in a normal session view; the
    // draft screen (centred composer) and the expanded editor keep it in flow.
    // On mobile the keyboard choreography still moves the form inside the
    // slot and shrinks the column around it, so the slot rides along unchanged.
    const floatingComposer = !draftLayoutVisible && !isDesktopExpandedInput;
    // The slot's height is published as `--chat-composer-inset` (the end fade
    // reads it) and the list footer's tail spacer reads
    // `--chat-composer-tail-inset` (see composerTailInset: a composer that
    // grows takes the gap above it before it pushes the transcript). Both are
    // written straight from the observer so composer growth never re-renders
    // the timeline, and onto the reading elements, not the column: inherited
    // from the column, every new composer line restyled the whole transcript
    // (composerInsetReaders). While the composer is taller than at rest,
    // `data-composer-grown` on the column hides the recap hint, which lies
    // in the gap under the latest answer the composer then grows into.
    React.useLayoutEffect(() => {
        const slot = composerSlotNode;
        const column = slot?.parentElement;
        if (!floatingComposer || !slot || !column || !globalThis.ResizeObserver) return;
        const update = () => {
            const height = Math.round(slot.getBoundingClientRect().height);
            // Only the composer itself at its natural height can set the
            // resting height. What stands in for it (a subagent's read-only
            // banner, the mobile comment composer: data-composer-transient)
            // and a slot the pill morph pins for its tween (an inline height,
            // measured with the keyboard's padding) are shorter, and kept as
            // the floor they left the composer "grown" (recap hidden) until a
            // reload.
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
