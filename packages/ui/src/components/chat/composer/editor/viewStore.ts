/**
 * Somewhere to keep a composer editor alive across an unmount.
 *
 * The mobile composer swaps between a collapsed pill and the full composer,
 * which are different subtrees — so the editor unmounts and mounts again on
 * every keyboard toggle. With a textarea that cost nothing. Building a
 * CodeMirror view is not nothing: extensions, state, document, decorations and
 * a first measure, all inside the tap's `flushSync`, before the browser is
 * allowed to paint the swap. That is enough to push the visible transformation
 * past the keyboard animation, which is what it looked like from the outside.
 *
 * Handing the editor a store owned by something longer-lived lets the view be
 * detached and re-attached instead of destroyed and rebuilt. Whoever creates
 * the store owns the view's lifetime and must destroy it.
 */

import type { EditorView } from '@codemirror/view';
import type { ComposerEditorProps } from './ComposerEditor';

export interface ComposerEditorViewStore {
    view: EditorView | null;
    /**
     * Where the view's extensions read their callbacks from. It lives here
     * rather than in the component so a kept-alive view keeps calling into
     * whichever instance is currently mounted, never a dead one.
     */
    handlers: { current: ComposerEditorProps } | null;
}

export function createComposerEditorViewStore(): ComposerEditorViewStore {
    return { view: null, handlers: null };
}
