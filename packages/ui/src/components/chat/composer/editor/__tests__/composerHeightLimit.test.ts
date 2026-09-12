import { describe, expect, test } from 'bun:test';

import { getComposerHeightLimit, getComposerHostHeightLimit } from '../heightLimit';

describe('getComposerHeightLimit', () => {
    test('keeps short composer content below both limits', () => {
        const contentHeight = 120;
        const limit = getComposerHeightLimit({
            maxLinesHeight: 360,
            boundHeight: 640,
            surroundingHeight: 180,
            boundGapPx: 4,
        });

        expect(Math.min(contentHeight, limit)).toBe(contentHeight);
    });

    test('[issue-2533] keeps long failed-dictation salvage text and its controls inside the mobile bound', () => {
        const salvageTextHeight = 1800;
        const boundHeight = 640;
        const surroundingHeight = 316;
        const boundGapPx = 4;
        const limit = getComposerHeightLimit({
            maxLinesHeight: 360,
            boundHeight,
            surroundingHeight,
            boundGapPx,
        });
        const appliedHeight = Math.min(salvageTextHeight, limit);

        expect(appliedHeight).toBe(320);
        expect(appliedHeight + surroundingHeight + boundGapPx).toBeLessThanOrEqual(boundHeight);
    });

    test('[issue-2533] keeps failed-dictation salvage text bounded after a short viewport reflow', () => {
        expect(getComposerHostHeightLimit({
            maxLinesHeight: 360,
            editorHeight: 52,
            renderedScrollHeight: 15,
            boundHeight: 361,
            branchHeight: 357,
            hostHeight: 52,
            boundGapPx: 4,
        })).toBe(52);
    });

    test('[issue-2533] does not feed the applied salvage height back into its limit', () => {
        const dimensions = {
            maxLinesHeight: 360,
            editorHeight: 52,
            renderedScrollHeight: 52,
            boundHeight: 640,
            boundGapPx: 4,
        };

        const initial = getComposerHostHeightLimit({
            ...dimensions,
            branchHeight: 316,
            hostHeight: 52,
        });
        const afterGrowth = getComposerHostHeightLimit({
            ...dimensions,
            branchHeight: 624,
            hostHeight: 360,
        });

        expect(initial).toBe(360);
        expect(afterGrowth).toBe(initial);
    });

    test('uses the line cap when a tablet has more vertical room', () => {
        expect(getComposerHeightLimit({
            maxLinesHeight: 360,
            boundHeight: 1200,
            surroundingHeight: 220,
            boundGapPx: 4,
        })).toBe(360);
    });

    test('keeps the line cap when no positive screen budget can be measured', () => {
        expect(getComposerHeightLimit({
            maxLinesHeight: 360,
            boundHeight: 320,
            surroundingHeight: 340,
            boundGapPx: 4,
        })).toBe(360);
    });

    test('falls back to the line cap when no screen bound is available', () => {
        expect(getComposerHeightLimit({ maxLinesHeight: 180 })).toBe(180);
    });
});
