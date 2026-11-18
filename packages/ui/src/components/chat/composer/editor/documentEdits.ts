import type { EditorState, TransactionSpec } from '@codemirror/state';

// external: #3013 CodeMirror normalizes CRLF, so caret offsets must follow the applied change set.
export const replaceWithCaret = (
    state: EditorState,
    from: number,
    to: number,
    insert: string,
    caret?: { anchor: number; head: number },
): TransactionSpec => {
    const changes = state.changes({ from, to, insert });
    const clamp = (position: number): number => Math.min(Math.max(position, 0), changes.newLength);
    const insertedLength = changes.newLength - (state.doc.length - (to - from));
    const anchor = caret ? clamp(caret.anchor) : from + insertedLength;
    const head = caret ? clamp(caret.head) : anchor;
    return { changes, selection: { anchor, head } };
};
