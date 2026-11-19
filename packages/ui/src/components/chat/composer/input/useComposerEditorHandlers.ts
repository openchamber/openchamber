import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerEditorActions } from './useComposerEditorActions';
import { type ComposerSelection } from '../../composer/editor/ComposerEditor';
import type { createComposerKeyHandler } from './createComposerKeyHandler';
import { useStableHandler } from './useStableHandler';

type Dependencies = {
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'handleComposerChange' | 'updateAutocompleteOverlayPosition'>;
    createComposerKeyHandler: Pick<ReturnType<typeof createComposerKeyHandler>, 'handleKeyDown'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteGesture'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'cursorPosRef'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileShell'>;
};

export function useComposerEditorHandlers({
    editorActions, createComposerKeyHandler, largePasteState, editorState, mobileShell: mobile,
}: Dependencies) {
    const { handleComposerChange, updateAutocompleteOverlayPosition } = editorActions;
    const { handleKeyDown } = createComposerKeyHandler;
    const { largeTextPasteGesture } = largePasteState;
    const { cursorPosRef } = editorState;
    const { mobileShell } = mobile;

    const handleEditorChange = useStableHandler(handleComposerChange);

    const handleEditorKeyDown = useStableHandler((event: KeyboardEvent) => {
        handleKeyDown(event);
        return event.defaultPrevented;
    });

    const handleEditorKeyUp = useStableHandler((event: KeyboardEvent) => largeTextPasteGesture.keyUp(event));

    const handleEditorSelectionChange = useStableHandler((selection: ComposerSelection) => {
        largeTextPasteGesture.invalidate();
        cursorPosRef.current = selection.start;
        updateAutocompleteOverlayPosition();
    });

    const handleEditorBlur = useStableHandler(() => {
        largeTextPasteGesture.invalidate();
        mobileShell.onEditorBlur();
    });

    return {
        handleEditorChange, handleEditorKeyDown, handleEditorKeyUp, handleEditorSelectionChange,
        handleEditorBlur,
    };
}
