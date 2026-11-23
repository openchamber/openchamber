import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerPermissionSettings } from './useComposerPermissionSettings';
import type { useComposerParallelRun } from './useComposerParallelRun';
import type { useComposerMentionAttachments } from './useComposerMentionAttachments';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerHistorySearchState } from './useComposerHistorySearchState';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerColumn } from './useComposerColumn';
import type { useComposerAttachmentWork } from './useComposerAttachmentWork';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SubmitOptions, ChatInputProps } from './chatInputProps';
import { useComposerQueueActions } from './useComposerQueueActions';
import { useComposerSubmission } from './useComposerSubmission';
type Dependencies = {
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'isMobileCommentOpen' | 'hasDrafts' | 'attachmentsToSend' | 'inlineDraftTarget' | 'consumeDrafts'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'waitForPendingAttachments'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteOffer'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'confirmedMentionsRef' | 'composerText' | 'currentChatDraftIdentityRef'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'getCurrentInputSnapshot' | 'pendingFirstSend' | 'composerQueuedMessages' | 'hasQueuedMessages'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'inputMode' | 'sendHeldByMissingFolderRef' | 'consumePendingSyntheticParts' | 'projectActionsRef' | 'clearAttachedFiles' | 'chatDraftIdentity' | 'isBtwActive' | 'btwPanel' | 'newSessionDraftOpen' | 'newSessionDraft' | 'btwDirectory' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'attachedFiles' | 'btwSessionId' | 'activeRuntimeKey' | 'immediateBtwSubmitRef' | 'sendHeldByMissingFolder' | 'setReviewDialogOpen' | 'isPromotedBtwSession' | 'btwComposerSessionId' | 'sessionFolder'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'messageQueueTarget' | 'addToQueue' | 'popQueuedToInput' | 'takeForSend'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'guestCommands' | 'readSessionMentionsBeforeSend' | 'linkedReferences' | 'availableSkills' | 'referenceLinksIn' | 'sessionMentionsIn' | 'rememberSessionMentions'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId' | 'mailboxTarget' | 'currentAgentName' | 'currentVariant' | 'effectiveBtwSelection'>;
    mentionAttachments: Pick<ReturnType<typeof useComposerMentionAttachments>, 'sanitizeAttachmentsForSend' | 'prepareReadOnSendMentions' | 'mentionableAgents' | 'extractInlineFileMentions'>;
    props: Pick<ChatInputProps, 'scrollToLatest' | 'scrollToBottom'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'setLinkedReferencesFor' | 'updateLinkedReferencesFor' | 'updateLinkedReferences'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    historySearchState: Pick<ReturnType<typeof useComposerHistorySearchState>, 'setPromptHistorySearch'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'openTimelineDialog'>;
    parallelRun: Pick<ReturnType<typeof useComposerParallelRun>, 'parallel'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase' | 'autoReviewRunning'>;
    expansion: Pick<ReturnType<typeof useComposerExpansion>, 'setExpandedInput'>;
    permissionSettings: Pick<ReturnType<typeof useComposerPermissionSettings>, 'pendingBtwPermissionMode'>;
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'runtimeTrackers'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'handoffDraft' | 'restoreDraft' | 'persistDraftImmediately' | 'messageHistory' | 'migrateDraft'>;
};

export function useComposerSending(dependencies: Dependencies) {
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});
    const handleQueueMessageRef = React.useRef<() => Promise<void>>(async () => {});
    const sendHandlers = { handleSubmitRef, handleQueueMessageRef };
    const sendMessage = React.useRef<ReturnType<typeof useSessionUIStore.getState>['sendMessage']>((...args) =>
        Promise.resolve(useSessionUIStore.getState().sendMessage(...args)),
    ).current;
    const queueActions = useComposerQueueActions({ ...dependencies, sendHandlers });
    handleQueueMessageRef.current = queueActions.handleQueueMessage;
    const submission = useComposerSubmission({ ...dependencies, sendHandlers, queueActions, sending: { sendMessage } });
    handleSubmitRef.current = submission.handleSubmit;
    return { ...queueActions, ...submission, ...sendHandlers, sendMessage };
}
