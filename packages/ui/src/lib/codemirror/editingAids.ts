import type { Extension } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { crosshairCursor, drawSelection, keymap, rectangularSelection } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { selectNextOccurrence } from '@codemirror/search';

/**
 * Editing help that needs no language server: the matching bracket lights up
 * and brackets and quotes close themselves. Word completion is deliberately
 * left out.
 */
export const bracketAids = (): Extension => [
    bracketMatching(),
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
];

/**
 * Several cursors: Alt+click adds one, Alt+drag selects a rectangle, and
 * Cmd/Ctrl+D adds the next occurrence of the selection. Desktop only: drawing
 * the selection itself replaces the native one, whose handles a touch screen
 * needs. Vim keeps Ctrl+D for scrolling half a page, so the key is left to it.
 */
export const multipleCursors = ({ vimMode }: { vimMode: boolean }): Extension => [
    EditorState.allowMultipleSelections.of(true),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    vimMode ? [] : keymap.of([{ key: 'Mod-d', run: selectNextOccurrence, preventDefault: true }]),
];
