import { EditorView } from '@codemirror/view';

// external: #3514 CodeMirror EditContext corrupts Android Gboard input in the composer.
export class ComposerEditorView extends EditorView {
    static EDIT_CONTEXT = false;
}
