import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useBtwStore } from '@/stores/useBtwStore';
import { useIsPageWaiting } from '@/sync/global-blocking-requests';
import { selectComposerQueue } from '../../composer/submit/buildOutgoingMessage';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { SubmitOptions } from './chatInputProps';

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 'hasText' | 'composerRef' | 'composerText'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'attachedFiles' | 'isBtwActive' | 'currentSessionId' | 'btwPanel'>
    & Pick<ReturnType<typeof useComposerInlineContext>, 'hasDrafts'>
    & Pick<ReturnType<typeof useComposerQueueState>, 'queuedMessages'>
    & Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase'>;

export function useComposerSendAvailability({
    hasText, attachedFiles, hasDrafts, queuedMessages, isBtwActive, currentSessionId, btwPanel, sessionPhase,
    composerRef, composerText,
}: Dependencies) {
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

    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});

    const handleQueueMessageRef = React.useRef<() => Promise<void>>(async () => {});

    return {
        handleQueueMessageRef, getCurrentInputSnapshot, handleSubmitRef, pendingFirstSend,
        composerQueuedMessages, hasQueuedMessages, isPageWaiting, hasContent, canAbort, canSend,
    };
}
