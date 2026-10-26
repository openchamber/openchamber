import { describe, expect, test } from 'bun:test';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { drawSelection, type EditorView } from '@codemirror/view';

import { handleComposerHostMouseDown } from '../hostMouseDown';

const padding = {} as Node;
const shell = {} as Node;
const text = {} as Node;

class ComposerViewHarness {
    state = EditorState.create({ doc: 'hello', extensions: [drawSelection()] });
    contentActive = false;
    windowActive = true;
    caretPainted = false;
    prevented = false;
    position: number | null = 2;
    readonly contentDOM = {
        isContentEditable: true,
        contains: (target: Node) => target === text,
    };

    focus(): void {
        this.windowActive = true;
        this.contentActive = true;
    }

    dispatch(spec: TransactionSpec): void {
        this.state = this.state.update(spec).state;
        this.caretPainted = this.windowActive && this.contentActive;
    }

    // Laid out, each line is 20px tall and starts 100px down the page.
    laidOut = false;
    readonly documentTop = 100;
    readonly defaultLineHeight = 20;

    lineBlockAt(position: number) {
        const top = (this.state.doc.lineAt(position).number - 1) * this.defaultLineHeight;
        return { top, bottom: top + this.defaultLineHeight };
    }

    // Laid out, a point resolves the way CodeMirror resolves it: above the
    // first line is the start of the draft, below the last line is its end,
    // and on a line every 10px of x is one character.
    posAtCoords({ x, y }: { x: number; y: number }): number | null {
        if (!this.laidOut) return this.position;
        const offset = y - this.documentTop;
        const doc = this.state.doc;
        if (offset < 0) return 0;
        if (offset > doc.lines * this.defaultLineHeight) return doc.length;
        const line = doc.line(Math.min(doc.lines, Math.floor(offset / this.defaultLineHeight) + 1));
        return line.from + Math.min(line.length, Math.round(x / 10));
    }

    mouseDown(target: Node, clientX = 10, clientY = 20): void {
        handleComposerHostMouseDown(this as unknown as EditorView, {
            target,
            clientX,
            clientY,
            preventDefault: () => { this.prevented = true; },
        });
    }
}

describe('composer host mouse down', () => {
    test('focuses before the first padding selection update paints the caret', () => {
        const view = new ComposerViewHarness();

        view.mouseDown(padding);

        expect(view.prevented).toBe(true);
        expect(view.contentActive).toBe(true);
        expect(view.state.selection.main.head).toBe(2);
        expect(view.caretPainted).toBe(true);
    });

    test('repaints after window reactivation even when focus bookkeeping is stale', () => {
        const view = new ComposerViewHarness();
        // The content remains active while CodeMirror's last notified focus is
        // stale; reactivating the window does not itself repaint drawSelection.
        view.contentActive = true;
        view.windowActive = false;
        view.caretPainted = false;

        view.mouseDown(shell);

        expect(view.windowActive).toBe(true);
        expect(view.caretPainted).toBe(true);
    });

    test('falls back to the document end when padding has no mapped position', () => {
        const view = new ComposerViewHarness();
        view.position = null;

        view.mouseDown(padding);

        expect(view.state.selection.main.head).toBe(5);
    });

    test('a click above or below the text keeps its x on the nearest line', () => {
        const view = new ComposerViewHarness();
        view.laidOut = true;
        view.state = EditorState.create({ doc: 'first line\nsecond line' });

        view.mouseDown(padding, 30, 90);
        expect(view.state.selection.main.head).toBe(3);

        view.mouseDown(padding, 30, 150);
        expect(view.state.selection.main.head).toBe(14);

        // Beside a line, in the side padding, the height is left alone.
        view.mouseDown(padding, 30, 125);
        expect(view.state.selection.main.head).toBe(14);
    });

    test('leaves native text selection and read-only editors alone', () => {
        const textView = new ComposerViewHarness();
        textView.mouseDown(text);
        expect(textView.prevented).toBe(false);
        expect(textView.contentActive).toBe(false);

        const readOnlyView = new ComposerViewHarness();
        readOnlyView.state = EditorState.create({
            doc: 'hello',
            extensions: [EditorState.readOnly.of(true), drawSelection()],
        });
        readOnlyView.mouseDown(padding);
        expect(readOnlyView.prevented).toBe(false);
        expect(readOnlyView.contentActive).toBe(false);
    });
});
