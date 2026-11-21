import React from 'react';
import { type ComposerEditorHandle } from '../../composer/editor/ComposerEditor';
import { createComposerEditorViewStore } from '../../composer/editor/viewStore';



export function useComposerEditorState() {
    const composerRef = React.useRef<ComposerEditorHandle>(null);
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
