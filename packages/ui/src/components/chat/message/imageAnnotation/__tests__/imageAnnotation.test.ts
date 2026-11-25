import { describe, expect, test } from 'bun:test';

import {
    ANNOTATION_HISTORY_LIMIT,
    annotationBounds,
    annotationExportSize,
    annotationFontSizeFor,
    annotationHistoryWith,
    annotationWidthFor,
    clampViewTransform,
    createAnnotationHistory,
    moveAnnotation,
    pointInNaturalSpace,
    redoAnnotationHistory,
    removeAnnotation,
    undoAnnotationHistory,
    zoomViewAt,
    type Annotation,
} from '@/lib/imageAnnotation';

const mark = (id: string, x: number, y: number): Annotation => ({
    id,
    tool: 'pen',
    points: [{ x, y }, { x: x + 20, y: y + 10 }],
    color: '#ef4444',
    width: 6,
});

describe('annotation history', () => {
    test('undo and redo walk the same stack', () => {
        const first = [mark('a', 0, 0)];
        const second = [mark('a', 0, 0), mark('b', 30, 30)];
        let history = annotationHistoryWith(createAnnotationHistory(), first);
        history = annotationHistoryWith(history, second);

        const undone = undoAnnotationHistory(history);
        expect(undone.present).toEqual(first);
        expect(undone.future).toEqual([second]);

        const redone = redoAnnotationHistory(undone);
        expect(redone.present).toEqual(second);
        expect(redone.past.length).toBe(2);
    });

    test('the past keeps at most the history limit', () => {
        let history = createAnnotationHistory();
        for (let index = 0; index < ANNOTATION_HISTORY_LIMIT + 12; index += 1) {
            history = annotationHistoryWith(history, [mark(`m${index}`, index, index)]);
        }
        expect(history.past.length).toBe(ANNOTATION_HISTORY_LIMIT);
    });

    test('undo and redo do nothing at the ends', () => {
        const history = createAnnotationHistory();
        expect(undoAnnotationHistory(history)).toBe(history);
        expect(redoAnnotationHistory(history)).toBe(history);
    });
});

describe('annotation geometry', () => {
    test('stroke width keeps about three screen pixels when fitted', () => {
        expect(annotationWidthFor(3000, 600)).toBe(15);
        expect(annotationWidthFor(100, 600)).toBe(2);
        expect(annotationFontSizeFor(15)).toBe(90);
    });

    test('export size caps the flattened image pixel count', () => {
        expect(annotationExportSize(4000, 3000)).toEqual({ width: 4000, height: 3000, scale: 1 });
        const capped = annotationExportSize(8000, 6000);
        expect(capped.scale).toBeCloseTo(Math.sqrt(16_000_000 / 48_000_000), 4);
        expect(capped.width).toBe(4619);
        expect(capped.height).toBe(3464);
    });

    test('a client point maps through the displayed rectangle into image pixels', () => {
        const rect = { left: 10, top: 20, width: 600, height: 300 };
        const natural = { width: 3000, height: 1500 };
        expect(pointInNaturalSpace({ x: 310, y: 170 }, rect, natural)).toEqual({ x: 1500, y: 750 });
        expect(pointInNaturalSpace({ x: -100, y: 900 }, rect, natural)).toEqual({ x: 0, y: 1500 });
    });

    test('the view cannot pan past the image edges', () => {
        expect(clampViewTransform({ scale: 1, offset: { x: 50, y: 50 } }, { width: 600, height: 400 }))
            .toEqual({ scale: 1, offset: { x: 0, y: 0 } });
        expect(clampViewTransform({ scale: 2, offset: { x: 500, y: -500 } }, { width: 600, height: 400 }))
            .toEqual({ scale: 2, offset: { x: 300, y: -200 } });
    });

    test('zooming around a point keeps that point fixed', () => {
        const zoomed = zoomViewAt({ scale: 1, offset: { x: 0, y: 0 } }, 2, { x: 100, y: 25 }, { width: 600, height: 400 });
        expect(zoomed.scale).toBe(2);
        expect(zoomed.offset).toEqual({ x: -100, y: -25 });
    });

    test('moving and removing an annotation leave the original array untouched', () => {
        const original = mark('a', 10, 20);
        const moved = moveAnnotation(original, 5, -5);
        expect(moved.points[0]).toEqual({ x: 15, y: 15 });
        expect(original.points[0]).toEqual({ x: 10, y: 20 });
        expect(removeAnnotation([original, mark('b', 0, 0)], 'a').map((entry) => entry.id)).toEqual(['b']);
    });

    test('the selection box covers text past its anchor', () => {
        const bounds = annotationBounds({
            id: 'text',
            tool: 'text',
            points: [{ x: 100, y: 100 }],
            color: '#ffffff',
            width: 6,
            text: 'Button',
        });
        expect(bounds.left).toBeLessThan(100);
        expect(bounds.width).toBeGreaterThan(100);
        expect(bounds.height).toBeGreaterThan(30);
    });
});