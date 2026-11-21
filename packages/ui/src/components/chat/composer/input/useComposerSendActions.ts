import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { ComposerSendHandlers } from './composerSendHandlers';
import React from 'react';
import type { ResolvedStarter } from '../../useDraftStarters';

type Dependencies = {
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'isMobileCommentOpen'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'pendingFirstSend' | 'getCurrentInputSnapshot' | 'isPageWaiting'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'inputMode' | 'currentSessionId'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'currentSessionPhase' | 'autoReviewRunning'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'followUpBehavior'>;
    queueActions: Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueueMessage'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText'>;
};

export function useComposerSendActions({
    inlineContext, sendAvailability, sendHandlers, sessionScope, sessionLifecycle, queueState,
    queueActions, editorState, draftText,
}: Dependencies) {
    const { isMobileCommentOpen } = inlineContext;
    const { pendingFirstSend, getCurrentInputSnapshot, isPageWaiting } = sendAvailability;
    const { handleSubmitRef } = sendHandlers;
    const { isBtwActive, inputMode, currentSessionId } = sessionScope;
    const { currentSessionPhase, autoReviewRunning } = sessionLifecycle;
    const { followUpBehavior } = queueState;
    const { handleQueueMessage } = queueActions;
    const { composerRef } = editorState;
    const { composerText } = draftText;

    const handlePrimaryAction = React.useCallback(() => {
        if (isMobileCommentOpen()) return;
        if (pendingFirstSend) return;
        const inputSnapshot = getCurrentInputSnapshot();
        const canQueue = !isBtwActive && !isPageWaiting && inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);
        if (followUpBehavior === 'queue' && canQueue) {
            void handleQueueMessage();
        } else if (followUpBehavior === 'steer' && canQueue) {
            void handleSubmitRef.current({ delivery: 'steer' });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, currentSessionPhase, autoReviewRunning, followUpBehavior, handleQueueMessage, isBtwActive, isPageWaiting, isMobileCommentOpen, pendingFirstSend, handleSubmitRef]);

    const submitPresetPrompt = React.useCallback((text: string, type: 'command' | 'skill') => {
        const draft = (composerRef.current?.getValue() ?? composerText.get()).trim();
        const presetText = draft ? `${text}${type === 'command' ? ' ' : '\n'}${draft}` : text;
        void handleSubmitRef.current({ presetText });
    }, [composerText, composerRef, handleSubmitRef]);

    const handlePresetChipSubmit = React.useCallback((starter: ResolvedStarter) => {
        submitPresetPrompt(starter.submitText, starter.ref.type);
    }, [submitPresetPrompt]);

    return {
        submitPresetPrompt, handlePrimaryAction, handlePresetChipSubmit,
    };
}
