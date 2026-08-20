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

    test('[issue-2533] keeps a long dictation and its controls inside the mobile bound', () => {
        const transcriptHeight = 1800;
        const boundHeight = 640;
        const surroundingHeight = 316;
        const boundGapPx = 4;
        const limit = getComposerHeightLimit({
            maxLinesHeight: 360,
            boundHeight,
            surroundingHeight,
            boundGapPx,
        });
        const appliedHeight = Math.min(transcriptHeight, limit);

        expect(appliedHeight).toBe(320);
        expect(appliedHeight + surroundingHeight + boundGapPx).toBeLessThanOrEqual(boundHeight);
    });

    test('[issue-2533] mirrors the editor limit after a short viewport reflow', () => {
        const scrollHeightLimit = 15;
        const editorHeight = 52;
        const renderedScrollHeight = 15;

        expect(getComposerHostHeightLimit(
            scrollHeightLimit,
            editorHeight,
            renderedScrollHeight,
        )).toBe(52);
    });

    test('uses the line cap when a tablet has more vertical room', () => {
        expect(getComposerHeightLimit({
            maxLinesHeight: 360,
            boundHeight: 1200,
            surroundingHeight: 220,
            boundGapPx: 4,
        })).toBe(360);
    });

    test('does not drop the screen cap when surrounding controls use all available room', () => {
        expect(getComposerHeightLimit({
            maxLinesHeight: 360,
            boundHeight: 320,
            surroundingHeight: 340,
            boundGapPx: 4,
        })).toBe(0);
    });

    test('falls back to the line cap when no screen bound is available', () => {
        expect(getComposerHeightLimit({ maxLinesHeight: 180 })).toBe(180);
    });
});
