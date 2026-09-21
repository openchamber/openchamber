import type { EditorView } from '@codemirror/view';
import type { MouseEvent } from 'react';

type ComposerHostMouseDownEvent = Pick<
    MouseEvent,
    'target' | 'clientX' | 'clientY' | 'preventDefault'
>;

export function handleComposerHostMouseDown(
    view: EditorView | null,
    event: ComposerHostMouseDownEvent,
): void {
    if (!view || view.state.readOnly || !view.contentDOM.isContentEditable) return;
    // A click that already landed in the text needs no help, and
    // forwarding it would break drag-selection.
    if (view.contentDOM.contains(event.target as Node)) return;

    event.preventDefault();
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
        ?? view.state.doc.length;
    // Focus before dispatching so CodeMirror updates the drawn caret's
    // visibility while applying the selection update.
    view.focus();
    view.dispatch({ selection: { anchor: position } });
}
