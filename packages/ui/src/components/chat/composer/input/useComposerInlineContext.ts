import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerColumn } from './useComposerColumn';
import React from 'react';
import { useInputStore, type ComposerAddress } from '@/sync/input-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getInlineCommentDraftKey, useInlineCommentDraftStore, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { attachmentsCitedIn } from '@/lib/attachmentIdentity';
import { useMobileCommentComposerController } from '../../composer/comment/MobileCommentComposerContext';

type Dependencies = {
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'btwComposerSessionId' | 'currentSessionId' | 'newSessionDraftOpen' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'attachedFiles' | 'activeRuntimeKey' | 'chatDraftIdentity'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
};

export function useComposerInlineContext({
    sessionScope, column, preferences,
}: Dependencies) {
    const {
        isBtwActive, btwComposerSessionId, currentSessionId, newSessionDraftOpen,
        currentSessionDirectoryForSync, currentDirectory, attachedFiles, activeRuntimeKey,
        chatDraftIdentity,
    } = sessionScope;
    const { columnPinned } = column;
    const { isMobile } = preferences;

    // Inline comment drafts
    const inlineDraftSessionKey = isBtwActive ? btwComposerSessionId ?? '' : currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');

    const inlineDraftDirectory = currentSessionDirectoryForSync ?? currentDirectory;

    const inlineDraftTarget = React.useMemo<InlineCommentDraftTarget | null>(
        () => inlineDraftSessionKey && inlineDraftDirectory
            ? { directory: inlineDraftDirectory, sessionKey: inlineDraftSessionKey }
            : null,
        [inlineDraftDirectory, inlineDraftSessionKey],
    );

    /**
     * The composer's files a message with `text` takes: those it or the
     * comments going with it cite (an image pasted into a comment), and the
     * annotations' screenshots.
     */
    const attachmentsToSend = React.useCallback((text: string): AttachedFile[] => {
        const drafts = inlineDraftTarget ? useInlineCommentDraftStore.getState().getDrafts(inlineDraftTarget) : [];
        const screenshots = new Set(drafts.flatMap((draft) => (draft.screenshot ? [draft.screenshot.toLowerCase()] : [])));
        const cited = new Set(attachmentsCitedIn([text, ...drafts.map((draft) => draft.text)].join('\n'), attachedFiles));
        return attachedFiles.filter((file) => cited.has(file) || screenshots.has(file.filename.toLowerCase()));
    }, [attachedFiles, inlineDraftTarget]);

    const inlineDraftKey = inlineDraftTarget
        ? getInlineCommentDraftKey(activeRuntimeKey, inlineDraftTarget.directory, inlineDraftTarget.sessionKey)
        : null;

    // Publish where the composer on screen files what other surfaces hand it:
    // inline drafts (file, diff, plan, terminal, PR and browser comments) and
    // attachments (a comment's image, an annotation's screenshot).
    const composerAddress = React.useMemo<ComposerAddress | null>(
        () => ({ inline: inlineDraftTarget, attachments: chatDraftIdentity }),
        [chatDraftIdentity, inlineDraftTarget],
    );

    React.useLayoutEffect(() => {
        if (columnPinned) return;
        useInputStore.getState().setComposerAddress(composerAddress);
        return () => useInputStore.getState().setComposerAddress(null);
    }, [columnPinned, composerAddress]);

    const draftCount = useInlineCommentDraftStore(
        React.useCallback(
            (state) => inlineDraftKey ? (state.drafts[inlineDraftKey] ?? []).length : 0,
            [inlineDraftKey]
        )
    );

    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);

    const hasDrafts = draftCount > 0;

    // Mobile comment mode (see composer/comment/): read imperatively here so
    // the send/queue guards below see the live state; rendering and lifecycle
    // live in useMobileCommentComposerMode further down.
    const mobileCommentController = useMobileCommentComposerController();

    const isMobileCommentOpen = React.useCallback(
        () => isMobile && mobileCommentController?.getState().status === 'open',
        [isMobile, mobileCommentController],
    );

    const attachMobileCommentRef = React.useRef<() => void>(() => undefined);

    return {
        inlineDraftSessionKey, hasDrafts, isMobileCommentOpen, attachmentsToSend, inlineDraftTarget,
        consumeDrafts, inlineDraftDirectory, attachMobileCommentRef,
    };
}
