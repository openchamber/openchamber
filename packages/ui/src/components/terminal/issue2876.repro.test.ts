import { describe, expect, test } from 'bun:test';

// Regression test for https://github.com/openchamber/openchamber/issues/2876
//
// [Bug] Pasting from the copy button in the shell widget to the terminal fails
//
// ghostty-web 0.4.0 arms SelectionManager.isSelecting on every canvas
// mousedown and copies on document mouseup. A plain click therefore copied the
// clicked cell over the shell widget's clipboard text. The dependency patch
// keeps selection armed until the pointer moves past half a cell, then copies
// only a real drag. Double-click word copying remains a separate path.
//
// The patch intentionally updates only ghostty-web's ESM bundle, matching the
// existing patch-package precedent; the UMD bundle remains unchanged.

type Cell = { col: number; absoluteRow: number };
type Point = { x: number; y: number };

const CELL_WIDTH = 10;
const DRAG_THRESHOLD = CELL_WIDTH * 0.5;

/**
 * Faithful model of the patched ghostty-web 0.4.0 SelectionManager mouse path:
 * - mousedown records the cell and pointer position and sets isSelecting
 * - movement below half a cell leaves the endpoint unchanged
 * - movement past the threshold extends the selection
 * - mouseup clears a click before the copy branch
 * - clearSelection() still has its hasSelection() early return
 */
const createGhosttySelectionModel = (screen: string[][]) => {
    let selectionStart: Cell | null = null;
    let selectionEnd: Cell | null = null;
    let isSelecting = false;
    let dragThresholdMet = false;
    let mouseDownX = 0;
    let mouseDownY = 0;
    const clipboardWrites: string[] = [];

    const getSelection = (): string => {
        if (!selectionStart || !selectionEnd) return '';
        let fromCol = selectionStart.col;
        let fromRow = selectionStart.absoluteRow;
        let toCol = selectionEnd.col;
        let toRow = selectionEnd.absoluteRow;
        if (fromRow > toRow || (fromRow === toRow && fromCol > toCol)) {
            [fromCol, toCol] = [toCol, fromCol];
            [fromRow, toRow] = [toRow, fromRow];
        }

        let result = '';
        for (let row = fromRow; row <= toRow; row += 1) {
            const line = screen[row];
            if (!line) continue;
            let lastNonSpace = -1;
            const startCol = row === fromRow ? fromCol : 0;
            const endCol = row === toRow ? toCol : line.length - 1;
            let cellText = '';
            for (let col = startCol; col <= endCol; col += 1) {
                const character = line[col];
                if (character && character !== ' ') {
                    cellText += character;
                    if (character.trim()) lastNonSpace = cellText.length;
                } else {
                    cellText += ' ';
                }
            }
            cellText = lastNonSpace >= 0 ? cellText.substring(0, lastNonSpace) : '';
            result += cellText;
            if (row < toRow) result += '\n';
        }
        return result;
    };

    // Patched hasSelection(): a pending single-cell click is not active while
    // the pointer is still below the drag threshold, but becomes clearable
    // after mouseup sets isSelecting to false.
    const hasSelection = (): boolean => {
        if (!selectionStart || !selectionEnd) return false;
        if (isSelecting && !dragThresholdMet) return false;
        return true;
    };

    // Keep the upstream early return: mouseup must set isSelecting false first
    // so a pending single cell reaches the clearing branch.
    const clearSelection = (): void => {
        if (!hasSelection()) return;
        selectionStart = null;
        selectionEnd = null;
        isSelecting = false;
    };

    const mousedown = (button: number, col: number, row: number, point: Point): void => {
        if (button !== 0) return;
        if (hasSelection()) clearSelection();
        selectionStart = { col, absoluteRow: row };
        selectionEnd = { col, absoluteRow: row };
        isSelecting = true;
        mouseDownX = point.x;
        mouseDownY = point.y;
        dragThresholdMet = false;
    };

    const markDragThreshold = (point: Point): boolean => {
        if (dragThresholdMet) return true;
        const dx = point.x - mouseDownX;
        const dy = point.y - mouseDownY;
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return false;
        dragThresholdMet = true;
        return true;
    };

    // Both the canvas mousemove and document mousemove handlers share the
    // patched threshold behavior. The latter is used when a drag leaves the
    // canvas before document mouseup.
    const move = (col: number, row: number, point: Point): void => {
        if (!isSelecting || !markDragThreshold(point)) return;
        selectionEnd = { col, absoluteRow: row };
    };

    const mouseup = (): void => {
        if (!isSelecting) return;
        isSelecting = false;
        if (!dragThresholdMet) {
            clearSelection();
            return;
        }
        const text = getSelection();
        if (text) clipboardWrites.push(text);
    };

    const getWordRange = (col: number, row: number): { startCol: number; endCol: number } | null => {
        const line = screen[row] ?? [];
        const isWordCharacter = (character: string | undefined): boolean => Boolean(character && /[\w-]/.test(character));
        if (!isWordCharacter(line[col])) return null;

        let startCol = col;
        let endCol = col;
        while (startCol > 0 && isWordCharacter(line[startCol - 1])) startCol -= 1;
        while (endCol + 1 < line.length && isWordCharacter(line[endCol + 1])) endCol += 1;
        return { startCol, endCol };
    };

    const doubleClick = (col: number, row: number): void => {
        const word = getWordRange(col, row);
        if (!word) return;
        selectionStart = { col: word.startCol, absoluteRow: row };
        selectionEnd = { col: word.endCol, absoluteRow: row };
        const text = getSelection();
        if (text) clipboardWrites.push(text);
    };

    return {
        mousedown,
        mousemove: move,
        documentMousemove: move,
        mouseup,
        outsideClick: mouseup,
        doubleClick,
        hasSelection,
        clearSelection,
        getSelection,
        get isSelecting(): boolean { return isSelecting; },
        get dragThresholdMet(): boolean { return dragThresholdMet; },
        clipboardWrites,
    };
};

describe('issue 2876: copy-on-click in the integrated terminal clobbers the clipboard', () => {
    const screen = [['$', ' ', 'e', 'c', 'h', 'o', ' ', 'h', 'i']];

    test('a plain click clears its single-cell state without writing to the clipboard', () => {
        const model = createGhosttySelectionModel(screen);

        model.mousedown(0, 3, 0, { x: 30, y: 0 });
        model.mouseup();

        expect(model.clipboardWrites).toEqual([]);
        expect(model.isSelecting).toBe(false);
        expect(model.getSelection()).toBe('');
    });

    test('sub-threshold movement does not extend the selection or copy', () => {
        const model = createGhosttySelectionModel(screen);

        model.mousedown(0, 2, 0, { x: 20, y: 0 });
        model.mousemove(5, 0, { x: 24, y: 0 });

        expect(model.hasSelection()).toBe(false);
        expect(model.dragThresholdMet).toBe(false);
        expect(model.getSelection()).toBe('e');

        model.mouseup();

        expect(model.clipboardWrites).toEqual([]);
        expect(model.isSelecting).toBe(false);
        expect(model.getSelection()).toBe('');
    });

    test('dragging past the threshold extends and copies the selected text', () => {
        const model = createGhosttySelectionModel(screen);

        model.mousedown(0, 2, 0, { x: 20, y: 0 });
        model.mousemove(5, 0, { x: 26, y: 0 });

        expect(model.hasSelection()).toBe(true);
        expect(model.dragThresholdMet).toBe(true);
        expect(model.getSelection()).toBe('echo');

        model.mouseup();

        expect(model.clipboardWrites).toEqual(['echo']);
        expect(model.isSelecting).toBe(false);
    });

    test('dragging outside the canvas updates the clamped endpoint and copies the selection', () => {
        const model = createGhosttySelectionModel(screen);
        const canvasWidth = screen[0].length * CELL_WIDTH;

        model.mousedown(0, 2, 0, { x: 20, y: 0 });
        model.documentMousemove(screen[0].length - 1, 0, { x: canvasWidth + CELL_WIDTH, y: 0 });

        expect(model.hasSelection()).toBe(true);
        expect(model.dragThresholdMet).toBe(true);
        expect(model.getSelection()).toBe('echo hi');

        model.mouseup();

        expect(model.clipboardWrites).toEqual(['echo hi']);
        expect(model.isSelecting).toBe(false);
    });

    test('a terminal press released outside clears pending selection without writing', () => {
        const model = createGhosttySelectionModel(screen);

        model.mousedown(0, 3, 0, { x: 30, y: 0 });
        model.outsideClick();

        expect(model.clipboardWrites).toEqual([]);
        expect(model.isSelecting).toBe(false);
        expect(model.getSelection()).toBe('');
    });

    test('double-click word copy remains available', () => {
        const model = createGhosttySelectionModel(screen);

        model.mousedown(0, 3, 0, { x: 30, y: 0 });
        model.mouseup();
        model.mousedown(0, 3, 0, { x: 30, y: 0 });
        model.mouseup();

        expect(model.clipboardWrites).toEqual([]);
        expect(model.isSelecting).toBe(false);
        expect(model.getSelection()).toBe('');

        model.doubleClick(3, 0);

        expect(model.clipboardWrites).toEqual(['echo']);
        expect(model.getSelection()).toBe('echo');
        expect(model.isSelecting).toBe(false);
    });
});
