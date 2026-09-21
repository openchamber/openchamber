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

    posAtCoords(): number | null {
        return this.position;
    }

    mouseDown(target: Node): void {
        handleComposerHostMouseDown(this as unknown as EditorView, {
            target,
            clientX: 10,
            clientY: 20,
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
