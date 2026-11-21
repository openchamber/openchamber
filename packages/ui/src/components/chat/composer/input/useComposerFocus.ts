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
        const frame = window.requestAnimationFrame(() => {
            if (columnPinned && !composerFormRef.current?.closest('[data-chat-column]')?.contains(document.activeElement)) return;
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
