import React from 'react';
import type { ResolvedStarter } from '../../useDraftStarters';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerInputState } from './useComposerInputState';

type Dependencies = Pick<ReturnType<typeof useComposerInlineContext>, 'isMobileCommentOpen'>
    & Pick<ReturnType<typeof useComposerSendAvailability>, 'pendingFirstSend' | 'getCurrentInputSnapshot' | 'isPageWaiting' | 'handleSubmitRef'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'inputMode' | 'currentSessionId'>
    & Pick<ReturnType<typeof useComposerSessionLifecycle>, 'currentSessionPhase' | 'autoReviewRunning'>
    & Pick<ReturnType<typeof useComposerQueueState>, 'followUpBehavior'>
    & Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueueMessage'>
    & Pick<ReturnType<typeof useComposerInputState>, 'composerRef' | 'composerText'>;

export function useComposerSendActions({
    isMobileCommentOpen, pendingFirstSend, getCurrentInputSnapshot, isBtwActive, isPageWaiting, inputMode,
    currentSessionId, currentSessionPhase, autoReviewRunning, followUpBehavior, handleQueueMessage,
    handleSubmitRef, composerRef, composerText,
}: Dependencies) {
    // Primary action for send/queue button — respects selected follow-up behavior
    const handlePrimaryAction = React.useCallback(() => {
        // Comment mode owns the composer; its only primary action is attach.
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

    // Draft welcome presets: submit immediately.
    const submitPresetPrompt = React.useCallback((text: string, type: 'command' | 'skill') => {
        // The text goes straight into the submit (see SubmitOptions.presetText)
        // instead of through the composer input — the collapsed mobile pill has
        // no mounted textarea to stage it in.
        const draft = (composerRef.current?.getValue() ?? composerText.get()).trim();
        // OpenCode recognizes slash commands only when their arguments follow
        // the command on the same line. Skills retain the multiline prompt form.
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
