import { EditorView } from '@codemirror/view';

/** The composer avoids CodeMirror EditContext because of the Android IME failure. */
export class ComposerEditorView extends EditorView {
    static EDIT_CONTEXT = false;
}
