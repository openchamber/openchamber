import React from 'react';
import { type ComposerEditorHandle } from '../../composer/editor/ComposerEditor';
import { createComposerEditorViewStore } from '../../composer/editor/viewStore';



export function useComposerEditorState() {
    const composerRef = React.useRef<ComposerEditorHandle>(null);
    // The mobile composer swaps between the collapsed pill and the full
    // composer, which unmounts the editor. Building a CodeMirror view is far
    // from free, and it would happen inside the tap that expands the pill —
    // before the browser may paint the swap. The store keeps one view alive for
    // as long as the composer itself is mounted.
    const composerViewStore = React.useRef(createComposerEditorViewStore()).current;

    React.useEffect(() => () => {
        composerViewStore.view?.destroy();
        composerViewStore.view = null;
    }, [composerViewStore]);

    const composerFormRef = React.useRef<HTMLFormElement | null>(null);
    const cursorPosRef = React.useRef(0);
    const shellTriggerNormalizationRef = React.useRef(false);

    return {
        composerRef, composerViewStore, composerFormRef, cursorPosRef, shellTriggerNormalizationRef,
    };
}
