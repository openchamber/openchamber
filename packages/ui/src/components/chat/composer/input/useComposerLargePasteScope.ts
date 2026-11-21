import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerEditorState } from './useComposerEditorState';
import React from 'react';
import { useInputStore } from '@/sync/input-store';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';



export function useComposerLargePasteScope({
    activeRuntimeKey, chatDraftIdentity, inputMode, largeTextPasteBehavior,
    largeTextPasteGesture, largeTextPasteOfferIdRef, setLargeTextPasteOffer, composerRef,
}: Pick<ReturnType<typeof useComposerSessionScope>, 'activeRuntimeKey' | 'chatDraftIdentity' | 'inputMode'>
    & Pick<ReturnType<typeof useComposerPreferences>, 'largeTextPasteBehavior'>
    & ReturnType<typeof useComposerLargePasteState>
    & Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>) {
    const largeTextPasteScope = JSON.stringify([
        activeRuntimeKey, chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : null,
        inputMode, largeTextPasteBehavior,
    ]);

    const largeTextPasteScopeRef = React.useRef(largeTextPasteScope);

    React.useLayoutEffect(() => {
        largeTextPasteScopeRef.current = largeTextPasteScope;
        largeTextPasteGesture.invalidate();
        largeTextPasteOfferIdRef.current += 1;
        setLargeTextPasteOffer(null);
        return () => largeTextPasteGesture.invalidate();
    }, [largeTextPasteGesture, largeTextPasteScope, largeTextPasteOfferIdRef, setLargeTextPasteOffer]);

    React.useEffect(() => subscribeRuntimeEndpointWillChange(() => largeTextPasteGesture.invalidate()), [largeTextPasteGesture]);

    const getLargeTextPasteScope = React.useCallback(() => (
        JSON.stringify([getRuntimeKey(), largeTextPasteScopeRef.current, useInputStore.getState().attachmentDraftKey])
    ), []);

    const readLargeTextPasteSnapshot = React.useCallback(() => {
        const editor = composerRef.current;
        if (!editor) return null;
        return {
            value: editor.getValue(), selection: editor.getSelection(),
            scope: getLargeTextPasteScope(),
        };
    }, [getLargeTextPasteScope, composerRef]);

    return {
        largeTextPasteScopeRef, getLargeTextPasteScope, readLargeTextPasteSnapshot,
    };
}
