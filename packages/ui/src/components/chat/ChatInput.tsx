import React from 'react';
import { usePendingSharedDraftContent } from '@/hooks/usePendingSharedDraftContent';
import { useI18n } from '@/lib/i18n';
import type { ChatInputProps } from './composer/input/chatInputProps';
import { createComposerKeyHandler } from './composer/input/createComposerKeyHandler';
import { renderComposerDialogs } from './composer/input/renderComposerDialogs';
import { renderComposerForm } from './composer/input/renderComposerForm';
import { useComposerAbortPrompt } from './composer/input/useComposerAbortPrompt';
import { useComposerAttachmentCompatibility } from './composer/input/useComposerAttachmentCompatibility';
import { useComposerAttachmentPreview } from './composer/input/useComposerAttachmentPreview';
import { useComposerAttachmentWork } from './composer/input/useComposerAttachmentWork';
import { useComposerAutocompleteState } from './composer/input/useComposerAutocompleteState';
import { useComposerColumn } from './composer/input/useComposerColumn';
import { useComposerCompletions } from './composer/input/useComposerCompletions';
import { useComposerControls } from './composer/input/useComposerControls';
import { useComposerDictation } from './composer/input/useComposerDictation';
import { useComposerDictationState } from './composer/input/useComposerDictationState';
import { useComposerDraftHistory } from './composer/input/useComposerDraftHistory';
import { useComposerDraftTarget } from './composer/input/useComposerDraftTarget';
import { useComposerDraftText } from './composer/input/useComposerDraftText';
import { useComposerDropState } from './composer/input/useComposerDropState';
import { useComposerEditorActions } from './composer/input/useComposerEditorActions';
import { useComposerEditorHandlers } from './composer/input/useComposerEditorHandlers';
import { useComposerEditorState } from './composer/input/useComposerEditorState';
import { useComposerExpansion } from './composer/input/useComposerExpansion';
import { useComposerExternalSubmits } from './composer/input/useComposerExternalSubmits';
import { useComposerFileDrop } from './composer/input/useComposerFileDrop';
import { useComposerFileIntake } from './composer/input/useComposerFileIntake';
import { useComposerFilePicker } from './composer/input/useComposerFilePicker';
import { useComposerFocus } from './composer/input/useComposerFocus';
import { useComposerGitStatus } from './composer/input/useComposerGitStatus';
import { useComposerHistorySearchState } from './composer/input/useComposerHistorySearchState';
import { useComposerInlineContext } from './composer/input/useComposerInlineContext';
import { useComposerLanguage } from './composer/input/useComposerLanguage';
import { useComposerLargePasteScope } from './composer/input/useComposerLargePasteScope';
import { useComposerLargePasteState } from './composer/input/useComposerLargePasteState';
import { useComposerMentionAttachments } from './composer/input/useComposerMentionAttachments';
import { useComposerMentionPaths } from './composer/input/useComposerMentionPaths';
import { useComposerMobileActions } from './composer/input/useComposerMobileActions';
import { useComposerMobilePanels } from './composer/input/useComposerMobilePanels';
import { useComposerMobileShell } from './composer/input/useComposerMobileShell';
import { useComposerParallelRun } from './composer/input/useComposerParallelRun';
import { useComposerPaste } from './composer/input/useComposerPaste';
import { useComposerPermissionSettings } from './composer/input/useComposerPermissionSettings';
import { useComposerPreferences } from './composer/input/useComposerPreferences';
import { useComposerQueueState } from './composer/input/useComposerQueueState';
import { useComposerReferenceActions } from './composer/input/useComposerReferenceActions';
import { useComposerReferenceDrafts } from './composer/input/useComposerReferenceDrafts';
import { useComposerReferencePicker } from './composer/input/useComposerReferencePicker';
import { useComposerReferencePickerState } from './composer/input/useComposerReferencePickerState';
import { useComposerReviewFlow } from './composer/input/useComposerReviewFlow';
import { useComposerRows } from './composer/input/useComposerRows';
import { useComposerRuntime } from './composer/input/useComposerRuntime';
import { useComposerSelection } from './composer/input/useComposerSelection';
import { useComposerSendActions } from './composer/input/useComposerSendActions';
import { useComposerSendAvailability } from './composer/input/useComposerSendAvailability';
import { useComposerSending } from './composer/input/useComposerSending';
import { useComposerSessionLifecycle } from './composer/input/useComposerSessionLifecycle';
import { useComposerSessionScope } from './composer/input/useComposerSessionScope';

const ChatInputComponent: React.FC<ChatInputProps> = ({
    onOpenSettings, scrollToBottom, scrollToLatest, active = true, draftPresentationExiting = false,
}) => {
    const props = { onOpenSettings, scrollToBottom, scrollToLatest, active, draftPresentationExiting };
    const column = useComposerColumn();
    const i18n = useI18n();
    const draftText = useComposerDraftText(column.chatColumnSession);
    const editorState = useComposerEditorState();
    const autocompleteState = useComposerAutocompleteState();
    const mobilePanels = useComposerMobilePanels();
    const historySearchState = useComposerHistorySearchState(editorState.composerFormRef);
    const dropState = useComposerDropState();
    const attachmentWork = useComposerAttachmentWork();
    const largePasteState = useComposerLargePasteState();
    const dictationState = useComposerDictationState();
    const sessionScope = useComposerSessionScope({ column, draftText });
    const selection = useComposerSelection({ column, editorState, sessionScope });
    const preferences = useComposerPreferences();
    const largePasteScope = useComposerLargePasteScope({
        ...sessionScope, ...preferences, ...largePasteState, ...editorState,
    });
    const expansion = useComposerExpansion(sessionScope.isBtwActive, preferences.isMobile);
    const runtime = useComposerRuntime();
    const mentionPaths = useComposerMentionPaths();
    const permissionSettings = useComposerPermissionSettings(sessionScope.currentSessionId);
    const attachmentPreview = useComposerAttachmentPreview();
    useComposerAttachmentCompatibility({ selection, sessionScope, i18n });
    useComposerGitStatus(sessionScope.currentDirectory, runtime.runtimeGit);
    const reviewFlow = useComposerReviewFlow({ sessionScope });
    const language = useComposerLanguage({
        selection, sessionScope, column, i18n, draftText, editorState, attachmentWork, preferences,
        largePasteScope,
    });
    const mentionAttachments = useComposerMentionAttachments({
        language, draftText, mentionPaths, sessionScope, selection,
    });
    const referencePickerState = useComposerReferencePickerState();
    const mobileShell = useComposerMobileShell({
        preferences, expansion, referencePickerState, editorState, mobilePanels, historySearchState,
        dropState, largePasteState,
    });
    const referenceDrafts = useComposerReferenceDrafts({ draftText, sessionScope });
    const queueState = useComposerQueueState({ sessionScope });
    const inlineContext = useComposerInlineContext({ sessionScope, column, preferences });
    const draftHistory = useComposerDraftHistory({
        sessionScope, inlineContext, historySearchState, draftText, editorState, column,
        autocompleteState,
    });
    const sessionLifecycle = useComposerSessionLifecycle({
        sessionScope, draftHistory, column, editorState, mobilePanels, draftText, preferences,
        selection,
    });
    const parallelRun = useComposerParallelRun({
        preferences, expansion, sessionScope, draftText, largePasteState, mobileShell,
    });
    const sendAvailability = useComposerSendAvailability({
        draftText, editorState, sessionScope, inlineContext, queueState, sessionLifecycle,
    });
    const referencePicker = useComposerReferencePicker({
        mobilePanels, referencePickerState, language, sessionScope, referenceDrafts,
    });
    const sending = useComposerSending({
        inlineContext, attachmentWork, largePasteState, i18n, draftText, editorState, sendAvailability,
        sessionScope, queueState, language, selection, mentionAttachments, props, referenceDrafts, preferences,
        historySearchState, column, parallelRun, sessionLifecycle, expansion, permissionSettings,
        runtime, draftHistory,
    });
    const sendActions = useComposerSendActions({
        inlineContext, sendAvailability, sendHandlers: sending, sessionScope, sessionLifecycle,
        queueState, queueActions: sending, editorState, draftText,
    });
    const dictation = useComposerDictation({
        draftText, i18n, dictationState, editorState, draftHistory, sendHandlers: sending,
    });
    useComposerExternalSubmits({ draftText, column, sendHandlers: sending, sendAvailability, sessionScope, submission: sending, sendActions, selection });
    const editorActions = useComposerEditorActions({
        preferences, expansion, largePasteScope, autocompleteState, draftText, editorState, dropState,
        column, i18n, largePasteState, sessionScope, sessionLifecycle, selection, language,
        referenceDrafts,
    });
    const fileIntake = useComposerFileIntake({
        editorState, draftText, i18n, attachmentWork, editorActions, selection, sessionScope,
        largePasteState, mobileShell,
    });
    usePendingSharedDraftContent({
        composerText: draftText.composerText,
        setMessage: draftText.setMessage,
        chatDraftIdentity: sessionScope.chatDraftIdentity,
        attachSharedFiles: fileIntake.attachSharedFiles,
        restoreDraft: draftHistory.restoreDraft,
    });
    const paste = useComposerPaste({
        sessionScope, language, editorState, draftText, largePasteState, attachmentWork, i18n,
        referenceDrafts, editorActions, preferences, largePasteScope, fileIntake, mobileShell,
    });
    const completions = useComposerCompletions({
        editorState, autocompleteState, draftText, i18n, mentionPaths, language, editorActions,
        referenceDrafts, sessionScope, sendHandlers: sending,
    });
    useComposerFocus({ props, sessionScope, preferences, column, editorState, mobilePanels });
    useComposerAbortPrompt({ sessionScope });
    const fileDrop = useComposerFileDrop({
        mentionPaths, draftText, i18n, dropState, editorState, sessionScope, selection, editorActions,
        fileIntake,
    });
    const filePicker = useComposerFilePicker({ fileIntake, runtime, i18n });
    const referenceActions = useComposerReferenceActions({
        referenceDrafts, sessionScope, i18n, editorState, draftText, column, language,
        attachmentPreview, mentionAttachments, fileIntake, referencePicker, referencePickerState,
        runtime,
    });
    const draftTarget = useComposerDraftTarget({
        sessionScope, runtime, mobilePanels, preferences, expansion, props,
    });
    const mobileActions = useComposerMobileActions({
        dictationState, autocompleteState, largePasteState, historySearchState, editorState, draftText,
        mobileShell, preferences, sessionScope, inlineContext, draftHistory,
    });
    const rows = useComposerRows({
        props, draftText, editorState, i18n, preferences, mobileShell, inlineContext, referenceActions,
        sendAvailability, sessionScope, queueState, draftTarget, selection, queueActions: sending,
        sessionLifecycle, editorActions, referencePicker,
    });
    const controls = useComposerControls({
        editorState, mobilePanels, draftText, i18n, preferences, expansion, permissionSettings,
        sessionScope, mobileShell, runtime, draftHistory,
    });
    const keyHandler = createComposerKeyHandler({
        largePasteState, editorState, draftText, autocompleteState, preferences, expansion,
        mobileActions, sessionScope, sessionLifecycle, editorActions, queueState, queueActions: sending,
        draftHistory, sendAvailability, submission: sending,
    });
    const editorHandlers = useComposerEditorHandlers({
        editorActions, createComposerKeyHandler: keyHandler, largePasteState, editorState, mobileShell,
    });
    return (
        <>
            {renderComposerForm({
                historySearchState, largePasteState, column, autocompleteState, dropState, i18n,
                editorState, draftText, mobilePanels, sessionScope, sessionLifecycle, draftHistory,
                mobileActions, inlineContext, sendActions, expansion, preferences, draftTarget,
                controls, props, mobileShell, language, sendAvailability, runtime, referenceActions,
                rows, filePicker, referencePicker, editorActions, completions, fileDrop, parallelRun,
                editorHandlers, paste, dictation, selection,
            })}
            {renderComposerDialogs({
                referencePickerState, mobileShell, language, referencePicker, referenceDrafts,
                sessionScope, reviewFlow, attachmentPreview, preferences, referenceActions, filePicker,
                mobilePanels, i18n, draftTarget,
            })}
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);
