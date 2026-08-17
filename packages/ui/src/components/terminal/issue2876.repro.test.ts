import { describe, expect, test } from 'bun:test';

import { shouldSuppressGhosttyCopyOnClick } from './ghosttyCopySuppression';

// Regression test for https://github.com/openchamber/openchamber/issues/2876
//
// [Bug] Pasting from the copy button in the shell widget to the terminal fails
//
// Symptom (macOS desktop): after clicking the copy button on the chat shell
// widget, pasting into the integrated terminal yields a single "random"
// character ~90% of the time. The character is stable across repeated pastes
// but changes on re-copy, is not the first/last character of the copied text,
// and pasting the same clipboard into an external app shows the same single
// character. Copying via terminal selection / Cmd+C works fine.
//
// Root cause: ghostty-web (v0.4.0, used by TerminalViewport.tsx) implements
// copy-on-click. Its SelectionManager:
//
//   mousedown (button 0) on the canvas:
//     selectionStart = selectionEnd = clicked cell
//     isSelecting = true
//   mouseup (document level):
//     if isSelecting:
//       text = getSelection()          // single character of the clicked cell
//       if text: copyToClipboard(text) // navigator.clipboard.writeText(char)
//
// So a plain left click on any character in the integrated terminal WRITES that
// single character to the system clipboard. The reporter's flow is:
//
//   1. click shell widget copy button  -> clipboard = full output
//   2. click into the integrated terminal to focus it
//      -> ghostty copies the character under the cursor to the clipboard
//   3. Cmd+V -> pastes that single character
//
// Fix: TerminalViewport registers a document-level `mouseup` listener in the
// CAPTURE phase. For a plain click (no real selection) inside the terminal
// container it stops propagation — so ghostty's document bubble-phase mouseup
// handler never runs — and clears the single-cell selection. Real drag
// selections (`hasSelection()` true) and clicks outside the terminal are
// untouched. The predicate is exported as
// `shouldSuppressGhosttyCopyOnClick(hasSelection, targetInContainer)` and
// tested directly below; the full event flow is modeled with a faithful
// ghostty SelectionManager plus a capture-phase suppress handler.

type Cell = { col: number; absoluteRow: number };

/**
 * Faithful model of ghostty-web v0.4.0 SelectionManager mouse handling
 * (packages from `node_modules/ghostty-web/dist/ghostty-web.js`):
 * - left mousedown on the canvas selects a single cell and arms isSelecting
 * - document-level mouseup copies the selection to the clipboard
 * - getSelection() returns the character(s) of the selected range
 * - hasSelection() is false for a single-cell (plain click) selection
 */
const createGhosttySelectionModel = (screen: string[][]) => {
    let selectionStart: Cell | null = null;
    let selectionEnd: Cell | null = null;
    let isSelecting = false;
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
                const char = line[col];
                if (char && char !== ' ') {
                    cellText += char;
                    if (char.trim()) lastNonSpace = cellText.length;
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

    // canvas mousedown listener
    const mousedown = (button: number, col: number, row: number): void => {
        if (button !== 0) return;
        selectionStart = { col, absoluteRow: row };
        selectionEnd = { col, absoluteRow: row };
        isSelecting = true;
    };

    // canvas mousemove listener (only extends the selection while selecting)
    const mousemove = (col: number, row: number): void => {
        if (!isSelecting) return;
        selectionEnd = { col, absoluteRow: row };
    };

    // document mouseup listener (bubble phase, as in the library)
    const mouseup = (): void => {
        if (!isSelecting) return;
        isSelecting = false;
        const text = getSelection();
        if (text) clipboardWrites.push(text); // copyToClipboard(text)
    };

    const hasSelection = (): boolean => {
        if (!selectionStart || !selectionEnd) return false;
        return !(selectionStart.col === selectionEnd.col && selectionStart.absoluteRow === selectionEnd.absoluteRow);
    };

    const clearSelection = (): void => {
        selectionStart = null;
        selectionEnd = null;
        isSelecting = false;
    };

    return { mousedown, mousemove, mouseup, hasSelection, clearSelection, getSelection, clipboardWrites };
};

/**
 * Model of TerminalViewport's capture-phase document mouseup handler: it
 * suppresses ghostty's copy when the click is a plain click (no real
 * selection) inside the terminal container, and leaves everything else alone.
 */
const createSuppressHandler = (model: ReturnType<typeof createGhosttySelectionModel>) => {
    const handleMouseUpCapture = (targetInContainer: boolean): boolean => {
        // Caller (TerminalViewport) filters clicks outside the container
        // before consulting the suppression predicate.
        if (!targetInContainer) return false;
        if (!shouldSuppressGhosttyCopyOnClick(model.hasSelection())) return false;
        model.clearSelection();
        return true; // stopPropagation: ghostty's bubble-phase mouseup never runs
    };
    return { handleMouseUpCapture };
};

describe('issue 2876: copy-on-click in the integrated terminal clobbers the clipboard', () => {
    test('a plain left click on a character writes that single character to the clipboard (bug)', () => {
        // Terminal screen: row 0 is `$ echo hi` (prompt + command).
        const screen = [['$', ' ', 'e', 'c', 'h', 'o', ' ', 'h', 'i']];

        // 1. User copied the shell widget output; clipboard holds the full text.
        const clipboard: string[] = ['pnpm install\n'];

        // 2. User clicks into the terminal to focus it — click lands on cell
        //    (col 3, row 0), the character 'c' of "echo".
        const model = createGhosttySelectionModel(screen);
        model.mousedown(0, 3, 0);
        model.mouseup();

        expect(model.getSelection()).toBe('c');
        expect(model.clipboardWrites).toEqual(['c']);

        // 3. ghostty-web copied the clicked character over the full output.
        for (const write of model.clipboardWrites) clipboard.unshift(write);
        expect(clipboard[0]).toBe('c');
    });

    test('the capture-phase suppress handler stops the plain-click copy (fix)', () => {
        const screen = [['$', ' ', 'e', 'c', 'h', 'o', ' ', 'h', 'i']];
        const clipboard: string[] = ['pnpm install\n'];

        // Plain click inside the terminal: mousedown selects the cell, then the
        // capture-phase mouseup suppresses the copy before ghostty's handler.
        const model = createGhosttySelectionModel(screen);
        const suppress = createSuppressHandler(model);
        model.mousedown(0, 3, 0);
        const suppressed = suppress.handleMouseUpCapture(true);

        expect(suppressed).toBe(true);
        expect(model.clipboardWrites).toEqual([]);
        expect(model.hasSelection()).toBe(false);

        // The clipboard still holds the shell widget output.
        expect(clipboard[0]).toBe('pnpm install\n');
    });

    test('drag selection still copies the selected text (not suppressed)', () => {
        const screen = [['$', ' ', 'e', 'c', 'h', 'o', ' ', 'h', 'i']];

        // Real drag selection: mousedown, mousemove to extend, mouseup.
        const model = createGhosttySelectionModel(screen);
        const suppress = createSuppressHandler(model);
        model.mousedown(0, 2, 0);
        // mousemove extends selectionEnd (mirrors the library's mousemove handler)
        model.mousemove(5, 0);

        // hasSelection() is now true, so the capture-phase handler does not
        // suppress; ghostty's bubble-phase mouseup copies the selection.
        const suppressed = suppress.handleMouseUpCapture(true);
        model.mouseup();

        expect(suppressed).toBe(false);
        expect(model.clipboardWrites[0]).toBe('echo');
    });

    test('clicks outside the terminal container are untouched', () => {
        const screen = [['$', ' ', 'e', 'c', 'h', 'o', ' ', 'h', 'i']];

        // Click outside the terminal: the capture-phase handler returns early
        // (target not in container) and ghostty's handler runs as before.
        const model = createGhosttySelectionModel(screen);
        const suppress = createSuppressHandler(model);
        model.mousedown(0, 3, 0);
        const suppressed = suppress.handleMouseUpCapture(false);
        model.mouseup();

        expect(suppressed).toBe(false);
        expect(model.clipboardWrites).toEqual(['c']);
    });

    test('clicking empty/whitespace cells does not clobber the clipboard (~10% success)', () => {
        const screen = [['$', ' ', 'e', 'c', 'h', 'o'], [], [' ', ' ', ' ']];

        const model = createGhosttySelectionModel(screen);
        model.mousedown(0, 1, 0); // the space in `$ echo`
        model.mouseup();
        model.mousedown(0, 0, 2); // an empty line
        model.mouseup();

        expect(model.clipboardWrites).toEqual([]);
    });
});
