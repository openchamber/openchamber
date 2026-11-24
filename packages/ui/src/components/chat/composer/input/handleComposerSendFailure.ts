import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useI18n } from '@/lib/i18n';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import { DraftSendError } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { AttachmentPathSaveError } from '@/sync/model-attachment-paths';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { createChatDraftIdentity, readChatDraft, getChatDraftIdentityKey, clearChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { useLinkedReferenceDrafts } from '../../composer/linkedReferenceDrafts';
import { AgentUnavailableError } from '@/lib/opencode/client';
import { isLocationNotFoundError } from '@/lib/opencode/location-errors';
import { isAmbiguousTransportFailure, isUndeliveredTransportFailure } from '@/lib/relay/transport-error';

const isLostPromptTransport = (error: unknown): boolean => {
    const cause = error instanceof Error ? error.cause : undefined;
    return [error, cause].some((candidate) => isAmbiguousTransportFailure(candidate) || isUndeliveredTransportFailure(candidate));
};

type SendFailureContext = Pick<ReturnType<typeof useComposerDraftText>, 'currentChatDraftIdentityRef' | 'composerText'>
    & Pick<ReturnType<typeof useI18n>, 't'>
    & Pick<ReturnType<typeof useComposerDraftHistory>, 'handoffDraft' | 'restoreDraft'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'chatDraftIdentity' | 'sessionFolder' | 'isBtwActive'>
    & {
    allAttachments: AttachedFile[];
    submitRuntimeKey: string;
    restoreConsumedDrafts: () => void;
    restoreComposerText: (target?: ChatDraftIdentity | null) => void;
};

export function handleComposerSendFailure(error: unknown, {
    currentChatDraftIdentityRef, handoffDraft, chatDraftIdentity, composerText, restoreDraft, t,
    sessionFolder, isBtwActive, allAttachments, submitRuntimeKey, restoreConsumedDrafts, restoreComposerText,
}: SendFailureContext) {
        const rawMessage =
            error instanceof Error
                ? error.message
                : typeof error === 'string'
                    ? error
                    : String(error ?? '');
        const normalized = rawMessage.toLowerCase();

        console.error('Message send failed:', rawMessage || error);
        restoreConsumedDrafts();
        const failedDraftSend = error instanceof DraftSendError ? error : null;
        const failedSessionIdentity = failedDraftSend
            ? createChatDraftIdentity(submitRuntimeKey, failedDraftSend.directory, failedDraftSend.sessionId)
            : null;
        if (failedDraftSend && failedSessionIdentity && !failedDraftSend.sessionCreated) {
            const shown = currentChatDraftIdentityRef.current;
            if (shown && getChatDraftIdentityKey(shown) === getChatDraftIdentityKey(failedSessionIdentity)) {
                handoffDraft(chatDraftIdentity, composerText.get());
            } else {
                const typedMeanwhile = readChatDraft(failedSessionIdentity).text;
                if (typedMeanwhile) restoreDraft(chatDraftIdentity, typedMeanwhile, new Set());
            }
            clearChatDraft(failedSessionIdentity);
        }
        const restoreTarget = (failedDraftSend?.sessionCreated ? failedSessionIdentity : null) ?? chatDraftIdentity;
        if (failedDraftSend?.sessionCreated) {
            useLinkedReferenceDrafts.getState().move(chatDraftIdentity, restoreTarget);
        }
        restoreComposerText(restoreTarget);

        const isSoftNetworkError =
            normalized.includes('timeout') ||
            normalized.includes('timed out') ||
            normalized.includes('may still be processing') ||
            normalized.includes('being processed') ||
            normalized.includes('failed to fetch') ||
            normalized.includes('networkerror') ||
            normalized.includes('network error') ||
            normalized.includes('gateway timeout') ||
            normalized === 'failed to send message';

        if (normalized.includes('payload too large') || normalized.includes('413') || normalized.includes('entity too large')) {
            toast.error(t('chat.chatInput.toast.attachmentsTooLarge'));
            if (allAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
            }
            return;
        }

        if (isSoftNetworkError) {
            if (allAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
                toast.error(t('chat.chatInput.toast.sendAttachmentsFailed'));
            }
            return;
        }

        if (isLostPromptTransport(error)) {
            if (allAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
            }
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
            return;
        }

        if (normalized.includes('runtime changed')) {
            if (allAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
            }
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
            return;
        }

        if (allAttachments.length > 0) {
            useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
        }

        if (normalized.includes('returned a web page instead of an api response') || normalized.includes('runtime_unavailable')) {
            toast.error(t('chat.chatInput.toast.messageSendFailed'));
            return;
        }

        const unavailableAgent = error instanceof AgentUnavailableError ? error
            : error instanceof Error && error.cause instanceof AgentUnavailableError ? error.cause
                : null;
        if (unavailableAgent) {
            toast.error(t('chat.chatInput.toast.agentUnavailable', { agent: unavailableAgent.agent }));
            return;
        }

        const unsavedAttachments = error instanceof AttachmentPathSaveError ? error
            : error instanceof Error && error.cause instanceof AttachmentPathSaveError ? error.cause
                : null;
        if (unsavedAttachments) {
            toast.error(t('chat.chatInput.toast.textModelImageSaveFailed', { files: unsavedAttachments.filenames.join(', ') }));
            return;
        }

        if (sessionFolder.tracked && !isBtwActive && error instanceof Error && isLocationNotFoundError(error)) {
            sessionFolder.markMissing();
            return;
        }

        toast.error(rawMessage || t('chat.chatInput.toast.messageSendFailed'));
    }
