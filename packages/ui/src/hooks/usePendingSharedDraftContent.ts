import React from 'react';

import { useChatColumnActions, useChatSessionSelection } from '@/components/chat/chatColumnSession';
import type { ComposerText } from '@/components/chat/composer/state/composerText';
import { appendWithLineBreaks } from '@/components/chat/composer/text';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function usePendingSharedDraftContent(
    composerText: ComposerText,
    setMessage: (value: string) => void,
    attachFilesWithCitation: (files: File[], leadingText?: string) => Promise<void>,
): void {
    const { pinned } = useChatColumnActions();
    const { sessionId } = useChatSessionSelection();
    const draftId = useSessionUIStore((state) => (
        !pinned && state.newSessionDraft?.open ? state.newSessionDraft.draftId : null
    ));
    const pending = useInputStore((state) => state.pendingDraftContent);

    React.useEffect(() => {
        if (sessionId !== null || draftId === null) return;
        if (pending === null || pending.draftId !== draftId) return;
        const content = useInputStore.getState().consumePendingDraftContent(draftId);
        if (content === null) return;
        if (content.files.length > 0) {
            void attachFilesWithCitation(content.files, content.text ?? '');
            return;
        }
        if (content.text) {
            const current = composerText.get();
            setMessage(current.trim().length > 0 ? appendWithLineBreaks(current, content.text) : content.text);
        }
    }, [attachFilesWithCitation, composerText, draftId, pending, sessionId, setMessage]);
}
