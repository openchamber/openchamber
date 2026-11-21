import React from 'react';

import { useChatColumnActions, useChatSessionSelection } from '@/components/chat/chatColumnSession';
import type { SharedAttachOptions } from '@/components/chat/composer/input/useComposerFileIntake';
import type { ComposerText } from '@/components/chat/composer/state/composerText';
import { appendWithLineBreaks } from '@/components/chat/composer/text';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { reportSkippedSharedFiles, type RejectedSharedFile } from '@/lib/nativeSharedFiles';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

type Dependencies = {
    composerText: ComposerText;
    setMessage: (value: string) => void;
    chatDraftIdentity: ChatDraftIdentity | null;
    attachSharedFiles: (files: File[], options: SharedAttachOptions) => Promise<RejectedSharedFile[]>;
    restoreDraft: (target: ChatDraftIdentity | null, draft: string, confirmedMentions: Set<string>) => void;
};

export function usePendingSharedDraftContent({
    composerText, setMessage, chatDraftIdentity, attachSharedFiles, restoreDraft,
}: Dependencies): void {
    const { pinned } = useChatColumnActions();
    const { sessionId } = useChatSessionSelection();
    const draftId = useSessionUIStore((state) => (
        !pinned && state.newSessionDraft?.open ? state.newSessionDraft.draftId : null
    ));
    const pending = useInputStore((state) => state.pendingDraftContent);

    React.useEffect(() => {
        if (sessionId !== null || draftId === null || chatDraftIdentity === null) return;
        if (pending === null || pending.draftId !== draftId) return;
        const content = useInputStore.getState().consumePendingDraftContent(draftId);
        if (content === null) return;
        content.accept?.();
        if (content.files.length > 0) {
            void attachSharedFiles(content.files, {
                leadingText: content.text ?? '',
                target: chatDraftIdentity,
                writeAway: (target, text) => restoreDraft(target, text, new Set()),
            }).then((refused) => {
                reportSkippedSharedFiles([...content.rejected, ...refused]);
            });
            return;
        }
        reportSkippedSharedFiles(content.rejected);
        if (content.text) {
            const current = composerText.get();
            setMessage(current.trim().length > 0 ? appendWithLineBreaks(current, content.text) : content.text);
        }
    }, [attachSharedFiles, chatDraftIdentity, composerText, draftId, pending, restoreDraft, sessionId, setMessage]);
}
