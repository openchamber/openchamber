import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { ChatInputProps } from './chatInputProps';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerInputState } from './useComposerInputState';

type Dependencies = Pick<ChatInputProps, 'active'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'clearAbortPrompt' | 'newSessionDraftOpen'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile'>
    & Pick<ReturnType<typeof useComposerInputState>, 'columnPinned' | 'composerFormRef' | 'composerRef' | 'setMobileControlsPanel' | 'canAcceptDropRef'>;

export function useComposerFocus({
    active, currentSessionId, isMobile, columnPinned, composerFormRef, composerRef, setMobileControlsPanel,
    clearAbortPrompt, canAcceptDropRef, newSessionDraftOpen,
}: Dependencies) {
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

    // A prompt armed for the session this composer leaves goes with it. Only
    // that one: another chat open beside this one arms prompts of its own.
    const abortPromptOwnerRef = React.useRef(currentSessionId);

    React.useEffect(() => {
        const previous = abortPromptOwnerRef.current;
        abortPromptOwnerRef.current = currentSessionId;
        if (previous !== currentSessionId && previous && useSessionUIStore.getState().abortPromptSessionId === previous) {
            clearAbortPrompt();
        }
    }, [currentSessionId, clearAbortPrompt]);

    React.useEffect(() => {
        canAcceptDropRef.current = Boolean(currentSessionId || newSessionDraftOpen);
    }, [currentSessionId, newSessionDraftOpen, canAcceptDropRef]);

}
