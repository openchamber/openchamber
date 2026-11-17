import { type ComposerSelection } from '../../composer/editor/ComposerEditor';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { createComposerKeyHandler } from './createComposerKeyHandler';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerMobileShell } from './useComposerMobileShell';
import { useStableHandler } from './useStableHandler';

type Dependencies = Pick<ReturnType<typeof useComposerEditorActions>, 'handleComposerChange' | 'updateAutocompleteOverlayPosition'>
    & Pick<ReturnType<typeof createComposerKeyHandler>, 'handleKeyDown'>
    & Pick<ReturnType<typeof useComposerInputState>, 'largeTextPasteGesture' | 'cursorPosRef'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'mobileShell'>;

export function useComposerEditorHandlers({
    handleComposerChange, handleKeyDown, largeTextPasteGesture, cursorPosRef,
    updateAutocompleteOverlayPosition, mobileShell,
}: Dependencies) {
    // The editor is memoized: stable handlers let it skip the composer's
    // renders while a reply streams, which change nothing it shows.
    const handleEditorChange = useStableHandler(handleComposerChange);

    const handleEditorKeyDown = useStableHandler((event: KeyboardEvent) => {
        // Every interception branch calls preventDefault, so the event itself
        // reports whether the composer consumed it.
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
