import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useBtwStore } from '@/stores/useBtwStore';
import { useIsPageWaiting } from '@/sync/global-blocking-requests';
import { selectComposerQueue } from '../../composer/submit/buildOutgoingMessage';

type Dependencies = {
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'hasText' | 'composerText'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'attachedFiles' | 'isBtwActive' | 'currentSessionId' | 'btwPanel'>;
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'hasDrafts'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'queuedMessages'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase'>;
};

export function useComposerSendAvailability({
    draftText, editorState, sessionScope, inlineContext, queueState, sessionLifecycle,
}: Dependencies) {
    const { hasText, composerText } = draftText;
    const { composerRef } = editorState;
    const { attachedFiles, isBtwActive, currentSessionId, btwPanel } = sessionScope;
    const { hasDrafts } = inlineContext;
    const { queuedMessages } = queueState;
    const { sessionPhase } = sessionLifecycle;

    // A linked reference is attached context, not decoration: the submission
    // builder serializes it into the outgoing message, so a composer holding
    // only one of those chips is not empty and has to be sendable on its own.
    // BTW sends strip every reference, so the gate stays out of BTW.
    const hasContent = hasText || attachedFiles.length > 0 || hasDrafts;

    const composerQueuedMessages = selectComposerQueue(queuedMessages);

    const hasQueuedMessages = !isBtwActive && composerQueuedMessages.length > 0;

    const preparingBtwSend = useBtwStore((state) => Boolean(currentSessionId && state.byParent[currentSessionId]?.pendingSend));

    // The session's first message is still on its way (its session being
    // created, its request about to leave): the composer keeps what is typed
    // and sends nothing until then, so a second message cannot overtake it.
    const pendingFirstSend = useSessionUIStore((s) => (currentSessionId ? s.pendingDraftSends.get(currentSessionId) ?? null : null));

    const canSend = (hasContent || hasQueuedMessages) && !(isBtwActive && (btwPanel.creating || preparingBtwSend)) && !pendingFirstSend;

    const canAbort = sessionPhase !== 'idle' && !pendingFirstSend;

    // While a page the agent showed waits for the user's answer, the turn
    // cannot end, so a queued message would never go out. The message is sent
    // at once instead: OpenCode hands it to the agent's plugin, which ends the
    // wait, and the agent reads the message next.
    const isPageWaiting = useIsPageWaiting(currentSessionId);

    // Reads the text through refs, so the send and queue callbacks built on
    // it keep their identity while the user types.
    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? composerText.get();
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
        };
    }, [attachedFiles.length, composerText, hasDrafts, composerRef]);


    return {
        getCurrentInputSnapshot, pendingFirstSend,
        composerQueuedMessages, hasQueuedMessages, isPageWaiting, hasContent, canAbort, canSend,
    };
}
