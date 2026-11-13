import * as React from 'react';

import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { useInputStore, type ComposerAddress } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Where a surface outside the chat column files what it hands the composer: a
 * comment (inline draft) or an image (attachment). The composer publishes its
 * own address, so a `/btw` fork takes them along with the input it owns.
 * `directory` is the caller's own notion of the project, used only while no
 * composer is mounted to publish one.
 */
const resolveInline = (
    published: InlineCommentDraftTarget | null,
    sessionKey: string | null,
    directory: string | null | undefined,
): InlineCommentDraftTarget | null => {
    if (published) return published;
    return directory && sessionKey ? { directory, sessionKey } : null;
};

const currentSessionKey = (): string | null => {
    const session = useSessionUIStore.getState();
    return session.currentSessionId ?? (session.newSessionDraft?.open ? 'draft' : null);
};

export const readComposerDraftTarget = (directory: string | null | undefined): InlineCommentDraftTarget | null => resolveInline(
    useInputStore.getState().composerAddress?.inline ?? null,
    currentSessionKey(),
    directory,
);

/** Capture both destinations before an asynchronous attach starts. */
export const readComposerAddress = (directory: string | null | undefined): ComposerAddress => {
    const address = useInputStore.getState().composerAddress;
    return {
        inline: resolveInline(address?.inline ?? null, currentSessionKey(), directory),
        attachments: address?.attachments ?? null,
    };
};

export const useComposerDraftTarget = (directory: string | null | undefined): InlineCommentDraftTarget | null => {
    const published = useInputStore((state) => state.composerAddress?.inline ?? null);
    const sessionKey = useSessionUIStore((state) => state.currentSessionId
        ?? (state.newSessionDraft?.open ? 'draft' : null));
    return React.useMemo(
        () => resolveInline(published, sessionKey, directory),
        [directory, published, sessionKey],
    );
};

/**
 * The attachment slot of the composer on screen, or null when none is mounted,
 * in which case the caller's files belong to whatever slot is current.
 */
export const readComposerAttachmentTarget = (): ChatDraftIdentity | null =>
    useInputStore.getState().composerAddress?.attachments ?? null;
