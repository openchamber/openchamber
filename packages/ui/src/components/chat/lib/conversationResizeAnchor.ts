// Pure "conversation seam" anchor model for the sidebar-resize controller.
//
// DOM-free. The controller anchors the NORMAL-FLOW start of the first user
// turn whose flow top sits inside the effective viewport (scroller top ..
// min(scroller bottom, composer top)) AND whose own user bubble OR the
// previous turn's assistant block is fully visible. The user bubble and the
// previous assistant block are QUALIFICATION + seam-diagnostic surfaces only —
// the anchor coordinate is always the turn's document-flow start
// ([data-chat-turn-flow-start], never the sticky bubble).
//
// The per-frame target uses the CURRENT scroll position (continuous-frame
// correct): after a write, the next frame's flow-top already reflects it, so
// recomputing from a captured initial scrollTop would double/under-compensate.
//   target = currentScrollTop + (currentFlowTop - capturedFlowViewportTop)
// Once the correction lands and nothing grows, currentFlowTop ===
// capturedFlowViewportTop -> delta 0 -> zero writes.

export interface SeamCandidate {
    /** Stable render-entry key (turn key). */
    key: string;
    /** Virtualizer row index (0 for non-virtualized surfaces). */
    rowIndex: number;
    /** Document-flow top of the turn (data-chat-turn-flow-start), viewport px. */
    flowTop: number;
    /** User question bubble rect (may be undefined for empty user messages). */
    userBubble?: { top: number; bottom: number };
    /** PREVIOUS turn's assistant block rect (undefined for the first turn). */
    previousAssistant?: { top: number; bottom: number };
}

export interface ConversationSeamAnchor {
    key: string;
    rowIndex: number;
    /** Captured viewport top of the turn's document-flow start. */
    capturedFlowViewportTop: number;
    /** bubble.top - flowStart.top at capture (sticky-independent offset). */
    bubbleOffsetFromFlow: number;
    /** flowStart.top - previousAssistant.bottom at capture (the seam gap). */
    previousAssistantGap: number | null;
}

export interface EffectiveViewport {
    top: number;
    bottom: number;
}

const EDGE_TOLERANCE_PX = 0.5;

export const isFullyVisible = (
    rect: { top: number; bottom: number },
    viewport: EffectiveViewport,
    tolerance = EDGE_TOLERANCE_PX,
): boolean => (
    rect.top >= viewport.top - tolerance && rect.bottom <= viewport.bottom + tolerance
);

/** Qualification + capture. Returns the seam anchor for the FIRST candidate
 *  whose flow top is inside the effective viewport AND whose user bubble or
 *  previous assistant block is fully visible. Never falls back to bottom. */
export const selectTurnSeam = (
    candidates: readonly SeamCandidate[],
    viewport: EffectiveViewport,
): ConversationSeamAnchor | null => {
    for (const candidate of candidates) {
        if (candidate.flowTop < viewport.top - EDGE_TOLERANCE_PX
            || candidate.flowTop > viewport.bottom + EDGE_TOLERANCE_PX) {
            continue;
        }
        const userVisible = candidate.userBubble
            ? isFullyVisible(candidate.userBubble, viewport)
            : false;
        const previousVisible = candidate.previousAssistant
            ? isFullyVisible(candidate.previousAssistant, viewport)
            : false;
        if (!userVisible && !previousVisible) {
            continue;
        }
        const bubbleOffsetFromFlow = candidate.userBubble
            ? candidate.userBubble.top - candidate.flowTop
            : 0;
        const previousAssistantGap = candidate.previousAssistant
            ? candidate.flowTop - candidate.previousAssistant.bottom
            : null;
        return {
            key: candidate.key,
            rowIndex: candidate.rowIndex,
            capturedFlowViewportTop: candidate.flowTop,
            bubbleOffsetFromFlow,
            previousAssistantGap,
        };
    }
    return null;
};

/** Continuous-frame-correct target: based on the CURRENT scrollTop, so after a
 *  write the next frame's flow-top already reflects it and the delta collapses
 *  to zero when nothing grows. */
export const computeSeamTarget = (
    anchor: Pick<ConversationSeamAnchor, 'capturedFlowViewportTop'>,
    currentScrollTop: number,
    currentFlowTop: number,
): number => Math.max(0, currentScrollTop + (currentFlowTop - anchor.capturedFlowViewportTop));

/** Seam diagnostics: the gap between the previous assistant bottom and the
 *  user bubble top, and any overlap (must always be 0). */
export const seamDiagnostics = (
    bubbleTop: number | null,
    previousAssistantBottom: number | null,
): { seamGap: number | null; overlapDepth: number } => {
    if (bubbleTop === null || previousAssistantBottom === null) {
        return { seamGap: null, overlapDepth: 0 };
    }
    const seamGap = bubbleTop - previousAssistantBottom;
    return { seamGap, overlapDepth: Math.max(0, -seamGap) };
};

/** Release ONLY when the composer covers the CAPTURED user-question top
 *  (capturedFlowViewportTop + bubbleOffsetFromFlow — the question box, not the
 *  flow start). A transient out-of-viewport flow start during a large reflow
 *  is correction input, never a release. */
export const shouldReleaseByComposer = (
    capturedBubbleTop: number,
    composerTop: number | null,
    tolerance = 1,
): boolean => composerTop !== null && composerTop <= capturedBubbleTop + tolerance;

/** Release when the document scroll bounds make the anchor mathematically
 *  impossible (scrolled to the very top or bottom). */
export const isAtScrollBounds = (
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    tolerance = 1,
): boolean => {
    const max = Math.max(0, scrollHeight - clientHeight);
    return scrollTop <= tolerance || scrollTop >= max - tolerance;
};

/** Bottom mode is only allowed when genuinely bottom-following. */
export const isAtBottom = (distanceFromBottom: number, threshold = 24): boolean => (
    distanceFromBottom <= threshold
);
