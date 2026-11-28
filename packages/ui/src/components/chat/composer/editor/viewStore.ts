
import type { EditorView } from '@codemirror/view';
import type { ComposerEditorProps } from './ComposerEditor';

export interface ComposerEditorViewStore {
    view: EditorView | null;
    handlers: { current: ComposerEditorProps } | null;
    historyEmptiedForRevision: { current: number | undefined } | null;
}

export function createComposerEditorViewStore(): ComposerEditorViewStore {
    return { view: null, handlers: null, historyEmptiedForRevision: null };
}
