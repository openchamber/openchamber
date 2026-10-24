import { Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/**
 * Keyboards without a Return key of their own — iOS in an action-key mode, and
 * third-party IMEs that answer a long press on the Send key — commit a newline
 * as a line break plus a padding space, then delete that space a few
 * milliseconds later with their own Backspace. The padding exists so the host
 * lays out a real paragraph break; the Backspace undoes it.
 *
 * When the space reaches the document, that cleanup Backspace removes it and
 * the break stays. When the split arrives as `insertParagraph` followed by a
 * separate `insertText " "`, the space does not reach the document, so the
 * composer holds one character fewer than the DOM. CodeMirror then sends the
 * keyboard's Backspace through the keymap, which deletes from the document —
 * and the character before the caret is the line break it just created.
 *
 * The fix takes that cleanup over in document terms: remove the padding space
 * when the document holds it, and never let the key or the DOM read remove the
 * line break the keyboard just made.
 */

/** Longer than the gap between a commit and its cleanup Backspace. */
const CLEANUP_WINDOW_MS = 400;

/**
 * Whether the document is missing the padding space the cleanup will look for,
 * i.e. whether the caret sits directly after a line break.
 */
export function caretFollowsLineBreak(head: number, charBefore: string): boolean {
    return head > 0 && charBefore === '\n';
}

export function imeNewlineCleanup(): Extension {
    let committedAt = 0;

    const armed = () => committedAt > 0 && Date.now() - committedAt <= CLEANUP_WINDOW_MS;

    return [
        EditorView.domEventHandlers({
            beforeinput: (event) => {
                // Both shapes the keyboard commits a newline with: one
                // `insertText` carrying the break, or a paragraph split.
                if (event.inputType === 'insertParagraph' || (event.inputType === 'insertText' && event.data?.includes('\n'))) {
                    committedAt = Date.now();
                }
                return false;
            },
        }),
        Prec.highest(keymap.of([
            {
                // A real Return also arrives as a paragraph split, so it clears
                // the mark before any Backspace can act on it.
                key: 'Enter',
                run: () => {
                    committedAt = 0;
                    return false;
                },
            },
            {
                key: 'Backspace',
                run: (view) => {
                    if (!armed()) return false;
                    committedAt = 0;

                    const head = view.state.selection.main.head;
                    const charBefore = view.state.sliceDoc(Math.max(0, head - 1), head);
                    if (charBefore === ' ') {
                        view.dispatch({ changes: { from: head - 1, to: head }, userEvent: 'delete.backward' });
                        return true;
                    }
                    return caretFollowsLineBreak(head, charBefore);
                },
            },
        ])),
        EditorView.inputHandler.of((view, from, to, text) => {
            // The same cleanup when CodeMirror applies the DOM read instead of
            // replaying the key: a one-character deletion of the break the
            // keyboard just made is that cleanup too.
            if (!armed()) return false;
            if (text !== '' || from + 1 !== to || view.state.sliceDoc(from, to) !== '\n') return false;
            committedAt = 0;
            return true;
        }),
    ];
}
