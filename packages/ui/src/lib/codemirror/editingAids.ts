import type { Extension } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { crosshairCursor, drawSelection, keymap, rectangularSelection } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { selectNextOccurrence } from '@codemirror/search';
import { timerCaretBlink } from './caretBlink';

export const bracketAids = (): Extension => [
    bracketMatching(),
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
];

export const multipleCursors = ({ vimMode }: { vimMode: boolean }): Extension => [
    EditorState.allowMultipleSelections.of(true),
    drawSelection(),
    timerCaretBlink(),
    rectangularSelection(),
    crosshairCursor(),
    vimMode ? [] : keymap.of([{ key: 'Mod-d', run: selectNextOccurrence, preventDefault: true }]),
];
