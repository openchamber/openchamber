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
    const position = view.posAtCoords({ x: event.clientX, y: clampToText(view, event.clientY) })
        ?? view.state.doc.length;
    // Focus before dispatching so CodeMirror updates the drawn caret's
    // visibility while applying the selection update.
    view.focus();
    view.dispatch({ selection: { anchor: position } });
}

// CodeMirror maps any point above the first line to the start of the draft
// and any point below the last line to its end, whatever the x. A textarea
// keeps the x on the nearest line, so move the point onto that line first.
function clampToText(view: EditorView, y: number): number {
    const halfLine = view.defaultLineHeight / 2;
    const firstLineMiddle = view.documentTop + view.lineBlockAt(0).top + halfLine;
    const lastLineMiddle = view.documentTop
        + view.lineBlockAt(view.state.doc.length).bottom - halfLine;
    return Math.min(Math.max(y, firstLineMiddle), lastLineMiddle);
}
