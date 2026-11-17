
import type { EditorView } from '@codemirror/view';
import type { ComposerEditorProps } from './ComposerEditor';

export interface ComposerEditorViewStore {
    view: EditorView | null;
    handlers: { current: ComposerEditorProps } | null;
}

export function createComposerEditorViewStore(): ComposerEditorViewStore {
    return { view: null, handlers: null };
}
