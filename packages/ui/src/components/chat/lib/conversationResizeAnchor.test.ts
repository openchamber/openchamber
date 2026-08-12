import { describe, expect, test } from 'bun:test';
import {
    computeSeamTarget,
    isAtBottom,
    isAtScrollBounds,
    isFullyVisible,
    seamDiagnostics,
    selectTurnSeam,
    shouldReleaseByComposer,
    type ConversationSeamAnchor,
    type EffectiveViewport,
    type SeamCandidate,
} from './conversationResizeAnchor';

// The review scenario: viewport 48.7..780.7; Decision 73's giant turn hangs in
// from above (flowTop far above the viewport) while Decision 74's flow start is
// the session seam the user is reading.
const viewport: EffectiveViewport = { top: 48.7, bottom: 780.7 };

const candidate73: SeamCandidate = {
    key: 'turn-73',
    rowIndex: 72,
    flowTop: -1780.1,
    userBubble: { top: -100, bottom: 400 },
};

const candidate74: SeamCandidate = {
    key: 'turn-74',
    rowIndex: 73,
    flowTop: 575.9,
    userBubble: { top: 585, bottom: 700 },
    previousAssistant: { top: 300, bottom: 555 },
};

describe('conversationResizeAnchor selectTurnSeam', () => {
    test('chooses Decision 74, not the giant turn-73 hanging in from above', () => {
        const result = selectTurnSeam([candidate73, candidate74], viewport);
        expect(result).not.toBeNull();
        expect(result!.key).toBe('turn-74');
        expect(result!.capturedFlowViewportTop).toBe(575.9);
    });

    test('bubbleOffsetFromFlow and previousAssistantGap are captured', () => {
        const result = selectTurnSeam([candidate74], viewport);
        expect(result).not.toBeNull();
        expect(Math.abs(result!.bubbleOffsetFromFlow - (585 - 575.9)) < 0.001).toBe(true);
        expect(Math.abs(result!.previousAssistantGap! - (575.9 - 555)) < 0.001).toBe(true);
    });

    test('qualification requires bubble OR previous assistant fully visible', () => {
        // Bubble bottom overflows the viewport AND previous assistant is
        // undefined -> not qualified.
        const unqualified = selectTurnSeam([
            { key: 'turn-x', rowIndex: 0, flowTop: 100, userBubble: { top: 100, bottom: 900 } },
        ], viewport);
        expect(unqualified).toBeNull();
    });

    test('null when the turn top is above the viewport (long-question mid-scroll)', () => {
        const result = selectTurnSeam([
            { key: 'turn-x', rowIndex: 0, flowTop: -500, userBubble: { top: -500, bottom: 300 } },
        ], viewport);
        expect(result).toBeNull();
    });

    test('empty candidates -> null (never bottom fallback)', () => {
        expect(selectTurnSeam([], viewport)).toBeNull();
    });
});

describe('conversationResizeAnchor computeSeamTarget (continuous-frame)', () => {
    const anchor: ConversationSeamAnchor = {
        key: 'turn-74',
        rowIndex: 73,
        capturedFlowViewportTop: 575.9,
        bubbleOffsetFromFlow: 9.1,
        previousAssistantGap: 20.9,
    };

    test('first frame: current scrollTop + current flow drift', () => {
        // Before any write: scrollTop 500, flowTop drifted +10 (content grew).
        expect(computeSeamTarget(anchor, 500, 585.9)).toBe(510);
    });

    test('after the write the flow top reflects it; no new growth -> delta 0', () => {
        // The write moved scrollTop 500 -> 510, so the flow start's viewport
        // top came back to the captured value; the NEXT frame recomputes from
        // the CURRENT scrollTop and sees zero drift -> zero write.
        expect(computeSeamTarget(anchor, 510, 575.9)).toBe(510);
    });

    test('a second growth of +5 from the settled state gives +5, never +15', () => {
        // Settled: scrollTop 510, flowTop back at 575.9. New growth +5 ->
        // flowTop 580.9. Target = 510 + 5 = 515 (NOT 500 + 15).
        expect(computeSeamTarget(anchor, 510, 580.9)).toBe(515);
    });

    test('no drift -> currentScrollTop (zero write)', () => {
        expect(computeSeamTarget(anchor, 510, 575.9)).toBe(510);
    });

    test('negative drift clamps at 0', () => {
        expect(computeSeamTarget(anchor, 10, 500)).toBe(0);
    });
});

describe('conversationResizeAnchor seamDiagnostics', () => {
    test('seam gap preserved and overlap always 0', () => {
        const d1 = seamDiagnostics(585, 555);
        expect(d1.seamGap).toBe(30);
        expect(d1.overlapDepth).toBe(0);
        // Overlap: previous assistant bottom below bubble top.
        const d2 = seamDiagnostics(555, 585);
        expect(d2.seamGap).toBe(-30);
        expect(d2.overlapDepth).toBe(30);
    });

    test('null inputs -> null gap, zero overlap', () => {
        expect(seamDiagnostics(null, 555)).toEqual({ seamGap: null, overlapDepth: 0 });
        expect(seamDiagnostics(585, null)).toEqual({ seamGap: null, overlapDepth: 0 });
    });
});

describe('conversationResizeAnchor isFullyVisible / isAtBottom', () => {
    test('fully visible within tolerance', () => {
        expect(isFullyVisible({ top: 49, bottom: 780 }, viewport)).toBe(true);
        expect(isFullyVisible({ top: 48.3, bottom: 780.2 }, viewport)).toBe(true);
        expect(isFullyVisible({ top: 48, bottom: 700 }, viewport)).toBe(false);
        expect(isFullyVisible({ top: 100, bottom: 781.3 }, viewport)).toBe(false);
    });

    test('bottom mode boundary at 24px', () => {
        expect(isAtBottom(23.9)).toBe(true);
        expect(isAtBottom(24)).toBe(true);
        expect(isAtBottom(24.1)).toBe(false);
    });
});

describe('conversationResizeAnchor release conditions', () => {
    const anchor: ConversationSeamAnchor = {
        key: 'turn-74',
        rowIndex: 73,
        capturedFlowViewportTop: 575.9,
        bubbleOffsetFromFlow: 9.1,
        previousAssistantGap: 20.9,
    };

    test('composer covering the CAPTURED question top releases', () => {
        const capturedBubbleTop = anchor.capturedFlowViewportTop + anchor.bubbleOffsetFromFlow;
        // Composer top (y) at/above the question top covers it.
        expect(shouldReleaseByComposer(capturedBubbleTop, capturedBubbleTop)).toBe(true);
        expect(shouldReleaseByComposer(capturedBubbleTop, capturedBubbleTop - 10)).toBe(true);
        // Composer top below the question top -> not covering.
        expect(shouldReleaseByComposer(capturedBubbleTop, capturedBubbleTop + 10)).toBe(false);
    });

    test('composer above the flow start but below the question top does not release', () => {
        // flow start 575.9, bubble top 585; composer top at 590 sits below the
        // question box -> no release even though the flow start is covered.
        expect(shouldReleaseByComposer(585, 590)).toBe(false);
    });

    test('document scroll bounds release only at the very top/bottom', () => {
        expect(isAtScrollBounds(0, 1000, 500)).toBe(true);
        expect(isAtScrollBounds(1, 1000, 500)).toBe(true);
        expect(isAtScrollBounds(499, 1000, 500)).toBe(true); // 1px from bottom
        expect(isAtScrollBounds(500, 1000, 500)).toBe(true); // exactly max
        expect(isAtScrollBounds(300, 1000, 500)).toBe(false);
    });
});
