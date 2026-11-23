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
    if (view.contentDOM.contains(event.target as Node)) return;

    event.preventDefault();
    const position = view.posAtCoords({ x: event.clientX, y: clampToText(view, event.clientY) })
        ?? view.state.doc.length;
    view.focus();
    view.dispatch({ selection: { anchor: position } });
}

function clampToText(view: EditorView, y: number): number {
    const halfLine = view.defaultLineHeight / 2;
    const firstLineMiddle = view.documentTop + view.lineBlockAt(0).top + halfLine;
    const lastLineMiddle = view.documentTop
        + view.lineBlockAt(view.state.doc.length).bottom - halfLine;
    return Math.min(Math.max(y, firstLineMiddle), lastLineMiddle);
}
