import React from 'react';
import type { ChatInputProps } from './composer/input/chatInputProps';
import { useComposerInputState } from './composer/input/useComposerInputState';
import { useComposerSessionScope } from './composer/input/useComposerSessionScope';
import { useComposerSelection } from './composer/input/useComposerSelection';
import { useComposerEnvironment } from './composer/input/useComposerEnvironment';
import { useComposerLanguage } from './composer/input/useComposerLanguage';
import { useComposerMentionAttachments } from './composer/input/useComposerMentionAttachments';
import { useComposerMobileShell } from './composer/input/useComposerMobileShell';
import { useComposerReferenceDrafts } from './composer/input/useComposerReferenceDrafts';
import { useComposerQueueState } from './composer/input/useComposerQueueState';
import { useComposerInlineContext } from './composer/input/useComposerInlineContext';
import { useComposerDraftHistory } from './composer/input/useComposerDraftHistory';
import { useComposerSessionLifecycle } from './composer/input/useComposerSessionLifecycle';
import { useComposerParallelRun } from './composer/input/useComposerParallelRun';
import { useComposerSendAvailability } from './composer/input/useComposerSendAvailability';
import { useComposerQueueActions } from './composer/input/useComposerQueueActions';
import { useComposerReferencePicker } from './composer/input/useComposerReferencePicker';
import { useComposerSubmission } from './composer/input/useComposerSubmission';
import { useComposerSendActions } from './composer/input/useComposerSendActions';
import { useComposerDictation } from './composer/input/useComposerDictation';
import { useComposerEditorActions } from './composer/input/useComposerEditorActions';
import { useComposerFileIntake } from './composer/input/useComposerFileIntake';
import { useComposerPaste } from './composer/input/useComposerPaste';
import { useComposerCompletions } from './composer/input/useComposerCompletions';
import { useComposerFocus } from './composer/input/useComposerFocus';
import { useComposerFileDrop } from './composer/input/useComposerFileDrop';
import { useComposerFilePicker } from './composer/input/useComposerFilePicker';
import { useComposerReferenceActions } from './composer/input/useComposerReferenceActions';
import { useComposerDraftTarget } from './composer/input/useComposerDraftTarget';
import { useComposerMobileActions } from './composer/input/useComposerMobileActions';
import { useComposerRows } from './composer/input/useComposerRows';
import { useComposerControls } from './composer/input/useComposerControls';
import { createComposerKeyHandler } from './composer/input/createComposerKeyHandler';
import { useComposerEditorHandlers } from './composer/input/useComposerEditorHandlers';
import { renderComposerForm } from './composer/input/renderComposerForm';
import { renderComposerDialogs } from './composer/input/renderComposerDialogs';

const ChatInputComponent: React.FC<ChatInputProps> = ({
    onOpenSettings, scrollToBottom, scrollToLatest, active = true, draftPresentationExiting = false,
}) => {
    const {
        chatColumnSession, inputModeParentRef, setInputMode, storedInputMode, columnPinned, composerText,
        composerFormRef, largeTextPasteGesture, largeTextPasteOfferIdRef, setLargeTextPasteOffer,
        composerRef, t, confirmedMentionsRef, pendingPastedAttachmentFilenamesRef, mobileControlsPanel,
        mobileAttachMenuOpen, mobileDraftPicker, promptHistorySearch, historyFocusPending, isDragging,
        currentChatDraftIdentityRef, setPromptHistorySearch, setHistoryFocusPending, setMessage,
        initialDraftRef, initialDraftIdentityRef, mentionCompletion, closeAutocomplete, focusColumnInput,
        setMobileControlsPanel, hasText, waitForPendingAttachments, openTimelineDialog, sendMessage,
        dictationSendEndRef, dictationSendInFlightRef, openAutocomplete, commandRef, skillRef, snippetRef,
        mentionRef, emojiRef, autocompleteQuery, dropZoneRef, setOpenAutocomplete, setAutocompleteQuery,
        suppressNextFileDropTextInsertRef, pendingDroppedAbsolutePathsRef,
        suppressNextFileDropTextInsertTimeoutRef, suppressNextFileMentionPasteRef,
        suppressNextFileMentionPasteTimeoutRef, completingMentionRef, shellTriggerNormalizationRef,
        setEditorValueRevision, pendingAttachWorkRef, canAcceptDropRef, dragEnterCountRef, isInternalDrag,
        setIsInternalDrag, setIsDragging, cursorPosRef, setMobileDraftPicker, largeTextPasteOffer,
        promptHistorySearchOwner, setMobileAttachMenuOpen, setPromptHistorySearchForm, composerViewStore,
        editorValueRevision,
    } = useComposerInputState();
    const {
        currentSessionId, currentDirectory, isBtwActive, btwComposerSessionId, sessionAgentPick,
        btwAgentSelection, btwModelSelection, activeRuntimeKey, chatDraftIdentity, inputMode, attachedFiles,
        closeReviewDialog, newSessionDraftOpen, newSessionDraft, currentSessionDirectoryForSync,
        btwSessionId, isBtwPanelVisible, draftCaretModeRef, immediateBtwSubmitRef, pendingBtwComposerRequest,
        consumePendingBtwComposerRequest, btwDirectory, btwPanel, sendHeldByMissingFolderRef,
        consumePendingSyntheticParts, projectActionsRef, clearAttachedFiles, sendHeldByMissingFolder,
        setReviewDialogOpen, isPromotedBtwSession, sessionFolder, pendingPresetSubmit, pendingDraftSubmit,
        clearAbortPrompt, abortCurrentOperation, pickSessionAgent, addAttachedFile, setPendingInputText,
        pendingGuestIssue, consumePendingGuestIssue, pendingComposerReferenceCount, setNewSessionDraftTarget,
        hasPendingForm, trustPausedDirectory, currentManagementSessionId, draftPermissionMode,
        setDraftPermissionMode, abortPromptSessionId, acknowledgeSessionAbort, claimAttachmentSlot,
        messageSelectionActive, hasPendingPermission, reviewDialogMounted, reviewDialogOpen,
    } = useComposerSessionScope({
        chatColumnSession, inputModeParentRef, setInputMode, storedInputMode, columnPinned, composerText,
    });
    const {
        currentProviderId, currentModelId, currentModelMetadata, agents, mailboxTarget, shownSessionId,
        currentAgentName, currentVariant, effectiveBtwSelection, configCatalogLoaded, setAgent,
        btwModelSelectorOpen, setBtwModelSelectorOpen, pinnedComposerSelection,
    } = useComposerSelection({
        columnPinned, currentSessionId, currentDirectory, isBtwActive, btwComposerSessionId,
        sessionAgentPick, btwAgentSelection, btwModelSelection, composerFormRef,
    });
    const {
        isMobile, largeTextPasteScopeRef, currentTheme, chatSearchDirectory, setExpandedInput,
        hasHardwareKeyboard, isTabletLayout, roomyForOnePanel, isExpandedInput, pendingBtwPermissionMode,
        runtimeTrackers, largeTextPasteBehavior, isDesktopExpanded, cycleAgentShortcut, enterToSend,
        enterToSendConfigured, mobileReturnKeySends, isComposerExpanded, getLargeTextPasteScope,
        readLargeTextPasteSnapshot, toMentionPath, vscodeApi, handleShowAttachmentPreview, isMobileExpanded,
        setSessionMode, inputBarOffset, chatInputRadius, inputSpellcheckEnabled, reviewFlowSubmitting,
        handleStartReviewFlow, attachmentPreviewMounted, attachmentPreview,
        handleAttachmentPreviewOpenChange,
    } = useComposerEnvironment({
        activeRuntimeKey, chatDraftIdentity, inputMode, largeTextPasteGesture, largeTextPasteOfferIdRef,
        setLargeTextPasteOffer, composerRef, isBtwActive, currentSessionId, currentProviderId,
        currentModelId, currentModelMetadata, attachedFiles, t, currentDirectory, closeReviewDialog,
    });
    const {
        knownAgentNamesRef, setConfirmedMentionsRevision, guestCommands, readSessionMentionsBeforeSend,
        linkedReferences, availableSkills, referenceLinksIn, sessionMentionsIn, rememberSessionMentions,
        referencePickerDirectory, chatDraftIdentityKeyRef, pastedSessionIds, linkPastedSessionId,
        setOpenSharedPageKey, sessionLinkOrigins, resolveSessionLinks, readPastedReferenceLinks,
        openSharedPageKey, chipOpenRef, chatDraftIdentityKey, attachmentFilenames, languageContext,
    } = useComposerLanguage({
        agents, currentDirectory, columnPinned, currentSessionId, newSessionDraftOpen, newSessionDraft,
        isMobile, attachedFiles, chatDraftIdentity, t, composerText, largeTextPasteScopeRef, composerRef,
        currentSessionDirectoryForSync, confirmedMentionsRef, inputMode, pendingPastedAttachmentFilenamesRef,
        currentTheme,
    });
    const {
        sanitizeAttachmentsForSend, prepareReadOnSendMentions, mentionableAgents, extractInlineFileMentions,
        prevWasAbortedRef,
    } = useComposerMentionAttachments({
        knownAgentNamesRef, confirmedMentionsRef, chatSearchDirectory, setConfirmedMentionsRevision,
        composerText, inputMode, isBtwActive, agents,
    });
    const {
        mobileComposerExpanded, setReferencePicker, mobileShell, mobileTextareaFocused, referencePicker,
    } = useComposerMobileShell({
        isMobile, composerRef, composerFormRef, setExpandedInput, hasHardwareKeyboard, isTabletLayout,
        roomyForOnePanel, mobileControlsPanel, mobileAttachMenuOpen, mobileDraftPicker, promptHistorySearch,
        historyFocusPending, isDragging,
    });
    const {
        setLinkedReferencesFor, updateLinkedReferencesFor, updateLinkedReferences, receivedPageBases,
        handleGuestAttach, setAttachDialogItem, setAttachDialogGuestId, attachDialogGuestId,
        attachDialogItem,
    } = useComposerReferenceDrafts({
        currentChatDraftIdentityRef, isBtwActive,
    });
    const {
        queuedMessages, messageQueueTarget, addToQueue, popQueuedToInput, takeForSend, followUpBehavior,
        parentMessageQueueTarget,
    } = useComposerQueueState({
        currentSessionDirectoryForSync, currentDirectory, currentSessionId, activeRuntimeKey, isBtwActive,
    });
    const {
        inlineDraftSessionKey, hasDrafts, isMobileCommentOpen, attachmentsToSend, inlineDraftTarget,
        consumeDrafts, inlineDraftDirectory, attachMobileCommentRef,
    } = useComposerInlineContext({
        isBtwActive, btwComposerSessionId, currentSessionId, newSessionDraftOpen,
        currentSessionDirectoryForSync, currentDirectory, attachedFiles, activeRuntimeKey, chatDraftIdentity,
        columnPinned, isMobile,
    });
    const {
        restoreDraft, handoffDraft, persistDraftImmediately, messageHistory, migrateDraft, applyHistoryValue,
        isPromptHistorySearchOpen, promptHistorySearchIdentity, cancelHistoryFocusFrame,
        promptHistorySearchIdentityRef, scheduleHistoryFocusFrame, historyValues,
    } = useComposerDraftHistory({
        activeRuntimeKey, currentSessionDirectoryForSync, currentDirectory, inlineDraftSessionKey,
        isBtwActive, btwSessionId, currentSessionId, chatDraftIdentity, inputMode, isBtwPanelVisible,
        promptHistorySearch, setPromptHistorySearch, setHistoryFocusPending, setMessage, composerRef,
        currentChatDraftIdentityRef, composerText, confirmedMentionsRef, columnPinned, initialDraftRef,
        initialDraftIdentityRef, newSessionDraftOpen, newSessionDraft, mentionCompletion, closeAutocomplete,
        setInputMode, draftCaretModeRef,
    });
    const {
        sessionPhase, autoReviewRunning, currentSessionPhase, handleExitBtw, handleOpenMobilePanel,
    } = useComposerSessionLifecycle({
        currentSessionId, immediateBtwSubmitRef, btwSessionId, activeRuntimeKey,
        currentSessionDirectoryForSync, currentDirectory, pendingBtwComposerRequest, isBtwActive,
        chatDraftIdentity, consumePendingBtwComposerRequest, restoreDraft, focusColumnInput,
        newSessionDraftOpen, columnPinned, isMobile, composerRef, btwDirectory, setMobileControlsPanel,
        setInputMode, mailboxTarget, shownSessionId, composerText, setMessage,
    });
    const {
        parallel, parallelProjectRef, handleRunInParallel, parallelRun,
    } = useComposerParallelRun({
        isMobile, isBtwActive, newSessionDraftOpen, newSessionDraft, composerText, setMessage,
        largeTextPasteGesture, mobileComposerExpanded, isExpandedInput,
    });
    const {
        handleQueueMessageRef, getCurrentInputSnapshot, handleSubmitRef, pendingFirstSend,
        composerQueuedMessages, hasQueuedMessages, isPageWaiting, hasContent, canAbort, canSend,
    } = useComposerSendAvailability({
        hasText, attachedFiles, hasDrafts, queuedMessages, isBtwActive, currentSessionId, btwPanel,
        sessionPhase, composerRef, composerText,
    });
    const {
        handleQueueMessage, handleQueuedMessageEdit, handleQueuedMessageSend,
    } = useComposerQueueActions({
        isMobileCommentOpen, waitForPendingAttachments, handleQueueMessageRef, getCurrentInputSnapshot,
        currentSessionId, messageQueueTarget, inputMode, hasDrafts, guestCommands, handleSubmitRef,
        sendHeldByMissingFolderRef, currentProviderId, currentModelId, readSessionMentionsBeforeSend,
        sanitizeAttachmentsForSend, attachmentsToSend, prepareReadOnSendMentions, t, linkedReferences,
        mentionableAgents, extractInlineFileMentions, availableSkills, consumePendingSyntheticParts,
        mailboxTarget, inlineDraftTarget, consumeDrafts, referenceLinksIn, projectActionsRef,
        sessionMentionsIn, scrollToLatest, setMessage, confirmedMentionsRef, clearAttachedFiles,
        chatDraftIdentity, setLinkedReferencesFor, isMobile, composerRef, addToQueue, currentAgentName,
        currentVariant, composerText, updateLinkedReferencesFor, updateLinkedReferences,
        rememberSessionMentions, popQueuedToInput,
    });
    const {
        trackerSources, handleOpenAgentPanel, openGitHubPicker, repositoryProvider, attachReferences,
        repositoryDescriptor,
    } = useComposerReferencePicker({
        setMobileControlsPanel, setReferencePicker, referencePickerDirectory, isBtwActive,
        updateLinkedReferencesFor, chatDraftIdentity, chatDraftIdentityKeyRef,
    });
    const {
        handleSubmit,
    } = useComposerSubmission({
        t, isMobileCommentOpen, waitForPendingAttachments, handleSubmitRef, isBtwActive, currentSessionId,
        btwPanel, pendingFirstSend, parallel, sessionPhase, messageQueueTarget, newSessionDraftOpen,
        newSessionDraft, composerQueuedMessages, effectiveBtwSelection, currentProviderId, currentModelId,
        currentAgentName, currentVariant, btwDirectory, currentSessionDirectoryForSync, currentDirectory,
        attachedFiles, hasDrafts, getCurrentInputSnapshot, autoReviewRunning, readSessionMentionsBeforeSend,
        hasQueuedMessages, inputMode, isMobile, btwSessionId, activeRuntimeKey, handoffDraft,
        chatDraftIdentity, immediateBtwSubmitRef, sendHeldByMissingFolder, confirmedMentionsRef,
        restoreDraft, guestCommands, setMessage, persistDraftImmediately, messageHistory,
        setPromptHistorySearch, handleQueueMessage, setExpandedInput, composerRef, scrollToBottom,
        openTimelineDialog, setReviewDialogOpen, prepareReadOnSendMentions, takeForSend, attachmentsToSend,
        consumePendingSyntheticParts, mailboxTarget, inlineDraftTarget, consumeDrafts, availableSkills,
        linkedReferences, referenceLinksIn, isPromotedBtwSession, sessionMentionsIn, mentionableAgents,
        extractInlineFileMentions, sanitizeAttachmentsForSend, projectActionsRef, clearAttachedFiles,
        sendMessage, btwComposerSessionId, pendingBtwPermissionMode, migrateDraft, runtimeTrackers,
        updateLinkedReferencesFor, currentChatDraftIdentityRef, composerText, sessionFolder,
    });
    const {
        submitPresetPrompt, handlePrimaryAction, handlePresetChipSubmit,
    } = useComposerSendActions({
        isMobileCommentOpen, pendingFirstSend, getCurrentInputSnapshot, isBtwActive, isPageWaiting,
        inputMode, currentSessionId, currentSessionPhase, autoReviewRunning, followUpBehavior,
        handleQueueMessage, handleSubmitRef, composerRef, composerText,
    });
    const {
        handleDictationInsert, handleDictationInsertAndSend, markDictationStart,
    } = useComposerDictation({
        currentChatDraftIdentityRef, restoreDraft, t, dictationSendEndRef, setMessage, composerText,
        composerRef, dictationSendInFlightRef, handleSubmitRef, immediateBtwSubmitRef, isBtwActive,
        chatDraftIdentity, handleSubmit, pendingPresetSubmit, columnPinned, submitPresetPrompt,
        newSessionDraftOpen, newSessionDraft, pendingDraftSubmit, configCatalogLoaded, currentProviderId,
        currentModelId, getCurrentInputSnapshot, mailboxTarget,
    });
    const {
        handleCycleAgent, insertTextAtSelection, updateAutocompleteState, markFileMentionPasteSuppression,
        clearDropTextSuppression, scheduleDropTextSuppressionExpiry, handleCycleThinking,
        handleOpenThinkingPanel, handleComposerChange, updateAutocompleteOverlayPosition, handleAbort,
        autocompleteOverlayPosition, dictationHeightHostRef, dictationContentHeight, dictationHeightLimit,
        useCompactChatPlaceholder, handleDictationContentHeightChange,
    } = useComposerEditorActions({
        isMobile, openAutocomplete, autocompleteQuery, composerText, composerRef, dropZoneRef,
        clearAbortPrompt, isBtwActive, btwSessionId, currentSessionId, abortCurrentOperation,
        handleOpenMobilePanel, currentProviderId, currentModelId, agents, currentAgentName, pickSessionAgent,
        columnPinned, setAgent, t, isComposerExpanded, inputMode, mentionCompletion, setOpenAutocomplete,
        setAutocompleteQuery, setMessage, suppressNextFileDropTextInsertRef, pendingDroppedAbsolutePathsRef,
        suppressNextFileDropTextInsertTimeoutRef, suppressNextFileMentionPasteRef,
        suppressNextFileMentionPasteTimeoutRef, pastedSessionIds, linkPastedSessionId, completingMentionRef,
        largeTextPasteBehavior, largeTextPasteGesture, getLargeTextPasteScope, shellTriggerNormalizationRef,
        setEditorValueRevision, setInputMode, closeAutocomplete, receivedPageBases, updateLinkedReferences,
        setOpenSharedPageKey,
    });
    const {
        attachFilesWithCitation, insertCitationAtSelection,
    } = useComposerFileIntake({
        composerRef, composerText, insertTextAtSelection, currentModelMetadata, currentModelId,
        currentProviderId, t, currentDirectory, pendingPastedAttachmentFilenamesRef, addAttachedFile,
        chatDraftIdentity, attachedFiles, pendingAttachWorkRef,
    });
    const {
        handlePaste,
    } = useComposerPaste({
        inputMode, sessionLinkOrigins, resolveSessionLinks, isBtwActive, readPastedReferenceLinks,
        currentSessionId, newSessionDraftOpen, composerRef, composerText, receivedPageBases, setMessage,
        updateAutocompleteState, largeTextPasteGesture, largeTextPasteBehavior, readLargeTextPasteSnapshot,
        attachFilesWithCitation, markFileMentionPasteSuppression, pastedSessionIds, insertTextAtSelection,
        pendingPastedAttachmentFilenamesRef, addAttachedFile, t, largeTextPasteOfferIdRef,
        setLargeTextPasteOffer, mobileShell,
    });
    const {
        handleCommandSelect, handleSkillSelect, handleSnippetSelect, snippetDraftText,
        handleSnippetDraftSaved, handleFileSelect, handleAgentSelect, handleSessionSelect,
        handleExtensionMentionSelect, handleEmojiSelect,
    } = useComposerCompletions({
        composerRef, completingMentionRef, closeAutocomplete, confirmedMentionsRef, toMentionPath,
        composerText, rememberSessionMentions, setMessage, updateAutocompleteState,
        currentChatDraftIdentityRef, t, handleGuestAttach, openAutocomplete, autocompleteQuery,
        currentSessionId, handleSubmitRef,
    });
    useComposerFocus({
        active, currentSessionId, isMobile, columnPinned, composerFormRef, composerRef,
        setMobileControlsPanel, clearAbortPrompt, canAcceptDropRef, newSessionDraftOpen,
    });
    const {
        handleDropCapture, handleDragEnter, handleDragOver, handleDragLeave, handleDrop, handleDragEnd,
    } = useComposerFileDrop({
        toMentionPath, confirmedMentionsRef, setPendingInputText, mailboxTarget, t, dragEnterCountRef,
        isInternalDrag, setIsInternalDrag, currentSessionId, newSessionDraftOpen, isDragging, setIsDragging,
        clearDropTextSuppression, composerRef, composerText, cursorPosRef, setMessage,
        pendingDroppedAbsolutePathsRef, attachFilesWithCitation, suppressNextFileDropTextInsertRef,
        scheduleDropTextSuppressionExpiry,
    });
    const {
        handlePickLocalFiles, fileInputRef, handleLocalFileSelect,
    } = useComposerFilePicker({
        attachFilesWithCitation, vscodeApi, t,
    });
    const {
        isVSCode, openAttachmentByName, trackerPickers, footerGapClass, guestAttachItems, openGuestAttach,
        openSharedPage,
    } = useComposerReferenceActions({
        setAttachDialogItem, setAttachDialogGuestId, currentDirectory, t, openSharedPageKey,
        linkedReferences, handleShowAttachmentPreview, chipOpenRef, setOpenSharedPageKey,
        sanitizeAttachmentsForSend, attachedFiles, chatDraftIdentityKey, composerRef, composerText,
        insertCitationAtSelection, pendingGuestIssue, columnPinned, isBtwActive, consumePendingGuestIssue,
        handleGuestAttach, currentSessionId, newSessionDraftOpen, newSessionDraft, activeRuntimeKey,
        pendingComposerReferenceCount, updateLinkedReferences, trackerSources, setReferencePicker,
    });
    const {
        showDraftTargetSelectors, messageWaitsForSpace, showDesktopDraftPresentation,
        draftPresentationClassName, draftHeading, draftProjectLabel, selectedDraftProject, draftProjects,
        selectedDraftDirectory, selectedDraftBranchLabel, selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges, projectRootBranchOption, worktreeBranchOptions,
        spaceBranchOptions, draftBranchItems, shouldShowDraftBranchSelector, handleDraftProjectChange,
        handleDraftDirectoryChange, refreshDraftTarget, handleCreateSpace, handleCreateCustomWorktree,
        handleMobileDraftPickerChange, abortShortcutReaches, newSpaceProject, setNewSpaceProject,
        newWorktreeProject, setNewWorktreeProject, handleCustomWorktreeCreated,
    } = useComposerDraftTarget({
        newSessionDraftOpen, isVSCode, setMobileDraftPicker, newSessionDraft, isBtwActive, isMobile,
        draftPresentationExiting, isDesktopExpanded, setNewSessionDraftTarget,
    });
    const {
        handlePromptHistoryShortcut, mobileCommentActive, mobileComment, pickPromptHistoryCandidate,
        closePromptHistorySearch, handleDictationSendStart, handleDictationActiveChange,
    } = useComposerMobileActions({
        dictationSendEndRef, dictationSendInFlightRef, mobileShell, isMobile, activeRuntimeKey,
        inlineDraftDirectory, inlineDraftSessionKey, inputMode, isBtwActive, isBtwPanelVisible,
        openAutocomplete, largeTextPasteOffer, isPromptHistorySearchOpen, setPromptHistorySearch,
        promptHistorySearchIdentity, composerRef, cancelHistoryFocusFrame, promptHistorySearchOwner,
        promptHistorySearchIdentityRef, scheduleHistoryFocusFrame, messageHistory, composerText,
        attachedFiles, applyHistoryValue, attachMobileCommentRef,
    });
    const {
        composerTopRows, contextRows, mobileModelAgentRow,
    } = useComposerRows({
        setMessage, isMobile, mobileComposerExpanded, mobileShell, composerRef, hasDrafts, inlineDraftTarget,
        openAttachmentByName, hasContent, newSessionDraftOpen, isBtwActive, isBtwPanelVisible,
        queuedMessages, hasPendingForm, currentSessionId, currentSessionDirectoryForSync, currentDirectory,
        setReviewDialogOpen, t, pendingFirstSend, showDraftTargetSelectors, messageWaitsForSpace,
        parentMessageQueueTarget, currentAgentName, handleQueuedMessageEdit, handleQueuedMessageSend,
        sessionFolder, sessionPhase, trustPausedDirectory, btwComposerSessionId, effectiveBtwSelection,
        handleOpenMobilePanel, handleCycleThinking, handleOpenThinkingPanel, handleOpenAgentPanel,
        handleCycleAgent,
    });
    const {
        pillText, footerIconButtonClass, iconSizeClass, sendIconSizeClass, stopIconSizeClass,
        openMobileAttachSheet, toggleDictation, desktopDictating, iconButtonBaseClass, goalObjectiveLength,
        footerPaddingClass, shownPermissionMode, isPermissionAutoAcceptInteractive,
        handlePermissionModeCycle, setDesktopDictating, waitingForOpenCode,
    } = useComposerControls({
        composerFormRef, setMobileAttachMenuOpen, composerRef, isMobile, isMobileExpanded,
        newSessionDraftOpen, mobileTextareaFocused, composerText, mobileComposerExpanded, isVSCode,
        isBtwActive, btwSessionId, currentSessionId, currentManagementSessionId, pendingBtwPermissionMode,
        draftPermissionMode, setDraftPermissionMode, setSessionMode, t, isPromptHistorySearchOpen,
        abortPromptSessionId, prevWasAbortedRef, acknowledgeSessionAbort,
    });
    const {
        handleKeyDown,
    } = createComposerKeyHandler({
        largeTextPasteGesture, largeTextPasteBehavior, handlePromptHistoryShortcut, isBtwActive, inputMode,
        composerRef, setInputMode, closeAutocomplete, composerText, openAutocomplete, commandRef, skillRef,
        snippetRef, mentionRef, emojiRef, currentSessionId, handleExitBtw, isDesktopExpanded,
        setExpandedInput, cycleAgentShortcut, handleCycleAgent, queuedMessages, attachedFiles,
        handleQueuedMessageEdit, messageHistory, applyHistoryValue, isMobile, enterToSend,
        enterToSendConfigured, mobileReturnKeySends, pendingFirstSend, isPageWaiting,
        getCurrentInputSnapshot, currentSessionPhase, autoReviewRunning, followUpBehavior, handleSubmit,
        handleQueueMessage,
    });
    const {
        handleEditorChange, handleEditorKeyDown, handleEditorKeyUp, handleEditorSelectionChange,
        handleEditorBlur,
    } = useComposerEditorHandlers({
        handleComposerChange, handleKeyDown, largeTextPasteGesture, cursorPosRef,
        updateAutocompleteOverlayPosition, mobileShell,
    });
    return (
        <>
            {renderComposerForm({
                setPromptHistorySearchForm, isBtwActive, largeTextPasteGesture, claimAttachmentSlot,
                handleExitBtw, isPromptHistorySearchOpen, mobileCommentActive, attachMobileCommentRef,
                handlePrimaryAction, isDesktopExpanded, isMobileExpanded, isMobile, inputBarOffset,
                showDesktopDraftPresentation, draftPresentationClassName, draftHeading, draftProjectLabel,
                isComposerExpanded, showDraftTargetSelectors, draftPresentationExiting, selectedDraftProject,
                draftProjects, selectedDraftDirectory, selectedDraftBranchLabel, selectedDraftBranchIsKnown,
                selectedDraftDirectoryHasUncommittedChanges, projectRootBranchOption, worktreeBranchOptions,
                spaceBranchOptions, draftBranchItems, shouldShowDraftBranchSelector,
                handleDraftProjectChange, handleDraftDirectoryChange, refreshDraftTarget, handleCreateSpace,
                handleCreateCustomWorktree, currentTheme, handleMobileDraftPickerChange,
                messageSelectionActive, currentSessionId, chatColumnSession, currentSessionDirectoryForSync,
                currentDirectory, chatInputRadius, mobileComment, mobileComposerExpanded, pillText,
                attachmentFilenames, newSessionDraftOpen, hasContent, pendingFirstSend, isVSCode, canAbort,
                footerIconButtonClass, iconSizeClass, sendIconSizeClass, stopIconSizeClass, composerTopRows,
                contextRows, mobileModelAgentRow, mobileShell, handlePickLocalFiles, openGitHubPicker,
                repositoryProvider, trackerPickers, openMobileAttachSheet, toggleDictation, handleAbort,
                largeTextPasteOffer, openAutocomplete, autocompleteQuery, autocompleteOverlayPosition,
                commandRef, skillRef, snippetRef, mentionRef, emojiRef, handleCommandSelect,
                handleSkillSelect, handleSnippetSelect, snippetDraftText, handleSnippetDraftSaved,
                handleFileSelect, handleAgentSelect, handleSessionSelect, handleExtensionMentionSelect,
                handleEmojiSelect, closeAutocomplete, promptHistorySearch, historyValues,
                pickPromptHistoryCandidate, closePromptHistorySearch, isDragging, dropZoneRef,
                desktopDictating, handleDropCapture, handleDragEnter, handleDragOver, handleDragLeave,
                handleDrop, handleDragEnd, iconButtonBaseClass, t, isInternalDrag, parallel,
                parallelProjectRef, dictationHeightHostRef, dictationContentHeight, dictationHeightLimit,
                composerRef, composerViewStore, composerText, editorValueRevision, languageContext,
                handleEditorChange, handleEditorKeyDown, handlePaste, handleEditorKeyUp,
                handleEditorSelectionChange, handleEditorBlur, inputMode, useCompactChatPlaceholder,
                hasHardwareKeyboard, mobileReturnKeySends, inputSpellcheckEnabled, abortShortcutReaches,
                goalObjectiveLength, footerPaddingClass, footerGapClass, canSend, shownPermissionMode,
                isPermissionAutoAcceptInteractive, onOpenSettings, guestAttachItems, openGuestAttach,
                handlePermissionModeCycle, handleDictationInsert, handleDictationInsertAndSend,
                handleDictationSendStart, markDictationStart, handleDictationContentHeightChange,
                setDesktopDictating, btwComposerSessionId, effectiveBtwSelection, btwModelSelectorOpen,
                setBtwModelSelectorOpen, pinnedComposerSelection, columnPinned, handleRunInParallel,
                parallelRun, waitingForOpenCode, handleDictationActiveChange, mobileControlsPanel,
                setMobileControlsPanel, handlePresetChipSubmit, isBtwPanelVisible, hasPendingPermission,
                btwPanel,
            })}
            {renderComposerDialogs({
                referencePicker, setReferencePicker, referencePickerDirectory, attachReferences,
                attachDialogGuestId, attachDialogItem, setAttachDialogGuestId, setAttachDialogItem,
                reviewDialogMounted, reviewDialogOpen, setReviewDialogOpen, currentSessionDirectoryForSync,
                currentDirectory, reviewFlowSubmitting, handleStartReviewFlow, linkedReferences,
                openSharedPageKey, updateLinkedReferences, openSharedPage, setOpenSharedPageKey,
                attachmentPreviewMounted, attachmentPreview, handleAttachmentPreviewOpenChange, isMobile,
                fileInputRef, handleLocalFileSelect, mobileAttachMenuOpen, t, setMobileAttachMenuOpen,
                mobileShell, handlePickLocalFiles, repositoryDescriptor, openGitHubPicker, trackerPickers,
                guestAttachItems, openGuestAttach, showDraftTargetSelectors, selectedDraftProject,
                draftProjects, selectedDraftDirectory, selectedDraftBranchLabel, selectedDraftBranchIsKnown,
                selectedDraftDirectoryHasUncommittedChanges, projectRootBranchOption, worktreeBranchOptions,
                spaceBranchOptions, draftBranchItems, shouldShowDraftBranchSelector,
                handleDraftProjectChange, handleDraftDirectoryChange, handleCreateSpace,
                handleCreateCustomWorktree, currentTheme, mobileDraftPicker, handleMobileDraftPickerChange,
                newSpaceProject, setNewSpaceProject, newWorktreeProject, setNewWorktreeProject,
                handleCustomWorktreeCreated,
            })}
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);
