import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobilePanels } from './useComposerMobilePanels';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerColumn } from './useComposerColumn';
import React from 'react';
import type { ChatInputProps } from './chatInputProps';

type Dependencies = {
    props: Pick<ChatInputProps, 'active'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerFormRef' | 'composerRef'>;
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'setMobileControlsPanel'>;
};

export function useComposerFocus({
    props, sessionScope, preferences, column, editorState, mobilePanels,
}: Dependencies) {
    const { active } = props;
    const { currentSessionId } = sessionScope;
    const { isMobile } = preferences;
    const { columnPinned } = column;
    const { composerFormRef, composerRef } = editorState;
    const { setMobileControlsPanel } = mobilePanels;

    React.useEffect(() => {
        if (!active || !currentSessionId || isMobile) return;
        // Focusing forces layout. Right after a session switch the layout is
        // dirty from the whole timeline mounting, so the focus call would pay
        // for that layout inside the commit; a frame later it is nearly free.
        const frame = window.requestAnimationFrame(() => {
            // A chat pinned in the side panel opens on its own time, often
            // while the user already types in the main chat; focusing then
            // would pull the keystrokes into the panel. It takes focus only
            // when the user is already working inside its column (e.g. opened
            // a subtask from there).
            if (columnPinned && !composerFormRef.current?.closest('[data-chat-column]')?.contains(document.activeElement)) return;
            // A rename that switched to this session (Rename on an inactive
            // tab) keeps its title field.
            if (document.activeElement?.closest('[data-session-rename-form]')) return;
            composerRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [active, columnPinned, currentSessionId, isMobile, composerRef, composerFormRef]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsPanel(null);
        }
    }, [isMobile, setMobileControlsPanel]);


}
