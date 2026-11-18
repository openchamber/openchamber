import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSendActions } from './useComposerSendActions';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useComposerRows } from './useComposerRows';
import type { useComposerReferencePicker } from './useComposerReferencePicker';
import type { useComposerReferenceActions } from './useComposerReferenceActions';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerPaste } from './useComposerPaste';
import type { useComposerParallelRun } from './useComposerParallelRun';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerMobilePanels } from './useComposerMobilePanels';
import type { useComposerMobileActions } from './useComposerMobileActions';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerHistorySearchState } from './useComposerHistorySearchState';
import type { useComposerFilePicker } from './useComposerFilePicker';
import type { useComposerFileDrop } from './useComposerFileDrop';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerEditorHandlers } from './useComposerEditorHandlers';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerDropState } from './useComposerDropState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftTarget } from './useComposerDraftTarget';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerDictation } from './useComposerDictation';
import type { useComposerControls } from './useComposerControls';
import type { useComposerCompletions } from './useComposerCompletions';
import type { useComposerColumn } from './useComposerColumn';
import type { useComposerAutocompleteState } from './useComposerAutocompleteState';
import { ParallelComposerStrip } from '../../composer/parallel/ParallelComposerStrip';
import { BtwPanel } from '../../btw/BtwPanel';
import { ActiveEditorFileSuggestion } from '../../FileAttachment';
import { withAttachmentChips } from '../../message/parts/attachmentCitationChips';
import { cn } from '@/lib/utils';
import { shouldPreserveDeferredEnterShift } from '../../composer/keyboardPolicy';
import { isIMECompositionEvent } from '@/lib/ime';
import { Icon } from '@/components/icon/Icon';
import { DraftPresetChips } from '../../DraftPresetChips';
import { hasOpenDropdown } from '@/hooks/keyboard-shortcut-dom';
import { ComposerEditor } from '../../composer/editor/ComposerEditor';
import { composerAutoCorrect } from '../../composer/editor/autocorrect';
import { MobileCommentComposer } from '../../composer/comment/MobileCommentComposer';
import { DraftTargetSelectors, MobileDraftTargetTriggers } from '../../composer/ui/DraftTargetSelectors';
import { ComposerAutocompletePopups } from '../../composer/ui/ComposerAutocompletePopups';
import { ComposerFooter } from '../../composer/ui/ComposerFooter';
import { MobilePillComposer } from '../../composer/ui/MobilePillComposer';
import { PromptHistorySearchPanel } from '../../composer/ui/PromptHistorySearchPanel';
import { LargeTextPasteChoice } from '../../composer/ui/LargeTextPasteChoice';
import { FormDock } from '@/components/chat/FormDock';
import { PermissionDock } from '@/components/chat/PermissionDock';
import { MessageSelectionBar } from '@/components/chat/messageSelection/MessageSelectionBar';
import type { ChatInputProps } from './chatInputProps';
import { renderDraftTitle } from './ComposerDraftTitle';
import { MAX_MOBILE_COMPOSER_LINES, MAX_VISIBLE_COMPOSER_LINES, MOBILE_COMPOSER_BOUND_GAP_PX } from './composerInputLimits';
import { MemoComposerDictation, MemoModelControls } from './memoComposerControls';

const NO_ATTACH_GUESTS: [] = [];

type Dependencies = {
    historySearchState: Pick<ReturnType<typeof useComposerHistorySearchState>, 'setPromptHistorySearchForm' | 'promptHistorySearch'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteGesture' | 'largeTextPasteOffer'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'chatColumnSession' | 'columnPinned'>;
    autocompleteState: Pick<ReturnType<typeof useComposerAutocompleteState>, 'openAutocomplete' | 'autocompleteQuery' | 'commandRef' | 'skillRef' | 'snippetRef' | 'mentionRef' | 'emojiRef' | 'closeAutocomplete'>;
    dropState: Pick<ReturnType<typeof useComposerDropState>, 'isDragging' | 'dropZoneRef' | 'isInternalDrag'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef' | 'composerViewStore'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText' | 'editorValueRevision'>;
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'mobileControlsPanel' | 'setMobileControlsPanel'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'claimAttachmentSlot' | 'messageSelectionActive' | 'currentSessionId' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'newSessionDraftOpen' | 'inputMode' | 'btwComposerSessionId' | 'isBtwPanelVisible' | 'hasPendingPermission' | 'btwPanel'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'handleExitBtw'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'isPromptHistorySearchOpen' | 'historyValues'>;
    mobileActions: Pick<ReturnType<typeof useComposerMobileActions>, 'mobileCommentActive' | 'mobileComment' | 'pickPromptHistoryCandidate' | 'closePromptHistorySearch' | 'handleDictationSendStart' | 'handleDictationActiveChange'>;
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'attachMobileCommentRef'>;
    sendActions: Pick<ReturnType<typeof useComposerSendActions>, 'handlePrimaryAction' | 'handlePresetChipSubmit'>;
    expansion: Pick<ReturnType<typeof useComposerExpansion>, 'isDesktopExpanded' | 'isMobileExpanded' | 'isComposerExpanded'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile' | 'inputBarOffset' | 'currentTheme' | 'chatInputRadius' | 'hasHardwareKeyboard' | 'mobileReturnKeySends' | 'inputSpellcheckEnabled'>;
    draftTarget: Pick<ReturnType<typeof useComposerDraftTarget>, 'showDesktopDraftPresentation' | 'draftPresentationClassName' | 'draftHeading' | 'draftProjectLabel' | 'showDraftTargetSelectors' | 'selectedDraftProject' | 'draftProjects' | 'selectedDraftDirectory' | 'selectedDraftBranchLabel' | 'selectedDraftBranchIsKnown' | 'selectedDraftDirectoryHasUncommittedChanges' | 'projectRootBranchOption' | 'worktreeBranchOptions' | 'spaceBranchOptions' | 'draftBranchItems' | 'shouldShowDraftBranchSelector' | 'handleDraftProjectChange' | 'handleDraftDirectoryChange' | 'refreshDraftTarget' | 'handleCreateSpace' | 'handleCreateCustomWorktree' | 'handleMobileDraftPickerChange'>;
    controls: Pick<ReturnType<typeof useComposerControls>, 'abortShortcutReaches' | 'pillText' | 'footerIconButtonClass' | 'iconSizeClass' | 'sendIconSizeClass' | 'stopIconSizeClass' | 'openMobileAttachSheet' | 'toggleDictation' | 'desktopDictating' | 'iconButtonBaseClass' | 'goalObjectiveLength' | 'footerPaddingClass' | 'shownPermissionMode' | 'isPermissionAutoAcceptInteractive' | 'handlePermissionModeCycle' | 'setDesktopDictating' | 'waitingForOpenCode' | 'footerGapClass'>;
    props: Pick<ChatInputProps, 'draftPresentationExiting' | 'onOpenSettings'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileComposerExpanded' | 'mobileShell'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'attachmentFilenames' | 'languageContext'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'hasContent' | 'pendingFirstSend' | 'canAbort' | 'canSend'>;
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'isVSCode'>;
    referenceActions: Pick<ReturnType<typeof useComposerReferenceActions>, 'trackerPickers' | 'guestAttachItems' | 'openGuestAttach'>;
    rows: Pick<ReturnType<typeof useComposerRows>, 'composerTopRows' | 'contextRows' | 'mobileModelAgentRow'>;
    filePicker: Pick<ReturnType<typeof useComposerFilePicker>, 'handlePickLocalFiles'>;
    referencePicker: Pick<ReturnType<typeof useComposerReferencePicker>, 'openGitHubPicker' | 'repositoryProvider'>;
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'handleAbort' | 'autocompleteOverlayPosition' | 'dictationHeightHostRef' | 'dictationContentHeight' | 'dictationHeightLimit' | 'useCompactChatPlaceholder' | 'handleDictationContentHeightChange'>;
    completions: Pick<ReturnType<typeof useComposerCompletions>, 'handleCommandSelect' | 'handleSkillSelect' | 'handleSnippetSelect' | 'snippetDraftText' | 'handleSnippetDraftSaved' | 'handleFileSelect' | 'handleAgentSelect' | 'handleSessionSelect' | 'handleExtensionMentionSelect' | 'handleEmojiSelect'>;
    fileDrop: Pick<ReturnType<typeof useComposerFileDrop>, 'handleDropCapture' | 'handleDragEnter' | 'handleDragOver' | 'handleDragLeave' | 'handleDrop' | 'handleDragEnd'>;
    parallelRun: Pick<ReturnType<typeof useComposerParallelRun>, 'parallel' | 'parallelProjectRef' | 'handleRunInParallel' | 'parallelRun'>;
    editorHandlers: Pick<ReturnType<typeof useComposerEditorHandlers>, 'handleEditorChange' | 'handleEditorKeyDown' | 'handleEditorKeyUp' | 'handleEditorSelectionChange' | 'handleEditorBlur'>;
    paste: Pick<ReturnType<typeof useComposerPaste>, 'handlePaste'>;
    dictation: Pick<ReturnType<typeof useComposerDictation>, 'handleDictationInsert' | 'handleDictationInsertAndSend' | 'markDictationStart'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'effectiveBtwSelection' | 'btwModelSelectorOpen' | 'setBtwModelSelectorOpen' | 'pinnedComposerSelection'>;
};

export function renderComposerForm({
    historySearchState, largePasteState, column, autocompleteState, dropState, i18n, editorState,
    draftText, mobilePanels, sessionScope, sessionLifecycle, draftHistory, mobileActions, inlineContext,
    sendActions, expansion, preferences, draftTarget, controls, props, mobileShell: mobile, language,
    sendAvailability, runtime, referenceActions, rows, filePicker, referencePicker, editorActions,
    completions, fileDrop, parallelRun: parallelControls, editorHandlers, paste, dictation, selection,
}: Dependencies) {
    const { setPromptHistorySearchForm, promptHistorySearch } = historySearchState;
    const { largeTextPasteGesture, largeTextPasteOffer } = largePasteState;
    const { chatColumnSession, columnPinned } = column;
    const {
        openAutocomplete, autocompleteQuery, commandRef, skillRef, snippetRef, mentionRef, emojiRef,
        closeAutocomplete,
    } = autocompleteState;
    const { isDragging, dropZoneRef, isInternalDrag } = dropState;
    const { t } = i18n;
    const { composerRef, composerViewStore } = editorState;
    const { composerText, editorValueRevision } = draftText;
    const { mobileControlsPanel, setMobileControlsPanel } = mobilePanels;
    const {
        isBtwActive, claimAttachmentSlot, messageSelectionActive, currentSessionId,
        currentSessionDirectoryForSync, currentDirectory, newSessionDraftOpen, inputMode,
        btwComposerSessionId, isBtwPanelVisible, hasPendingPermission, btwPanel,
    } = sessionScope;
    const { handleExitBtw } = sessionLifecycle;
    const { isPromptHistorySearchOpen, historyValues } = draftHistory;
    const {
        mobileCommentActive, mobileComment, pickPromptHistoryCandidate, closePromptHistorySearch,
        handleDictationSendStart, handleDictationActiveChange,
    } = mobileActions;
    const { attachMobileCommentRef } = inlineContext;
    const { handlePrimaryAction, handlePresetChipSubmit } = sendActions;
    const { isDesktopExpanded, isMobileExpanded, isComposerExpanded } = expansion;
    const {
        isMobile, inputBarOffset, currentTheme, chatInputRadius, hasHardwareKeyboard,
        mobileReturnKeySends, inputSpellcheckEnabled,
    } = preferences;
    const {
        showDesktopDraftPresentation, draftPresentationClassName, draftHeading, draftProjectLabel,
        showDraftTargetSelectors, selectedDraftProject, draftProjects, selectedDraftDirectory,
        selectedDraftBranchLabel, selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges, projectRootBranchOption, worktreeBranchOptions,
        spaceBranchOptions, draftBranchItems, shouldShowDraftBranchSelector, handleDraftProjectChange,
        handleDraftDirectoryChange, refreshDraftTarget, handleCreateSpace, handleCreateCustomWorktree,
        handleMobileDraftPickerChange,
    } = draftTarget;
    const {
        abortShortcutReaches, pillText, footerIconButtonClass, iconSizeClass, sendIconSizeClass,
        stopIconSizeClass, openMobileAttachSheet, toggleDictation, desktopDictating,
        iconButtonBaseClass, goalObjectiveLength, footerPaddingClass, shownPermissionMode,
        isPermissionAutoAcceptInteractive, handlePermissionModeCycle, setDesktopDictating,
        waitingForOpenCode, footerGapClass,
    } = controls;
    const { draftPresentationExiting, onOpenSettings } = props;
    const { mobileComposerExpanded, mobileShell } = mobile;
    const { attachmentFilenames, languageContext } = language;
    const { hasContent, pendingFirstSend, canAbort, canSend } = sendAvailability;
    const { isVSCode } = runtime;
    const { trackerPickers, guestAttachItems, openGuestAttach } = referenceActions;
    const { composerTopRows, contextRows, mobileModelAgentRow } = rows;
    const { handlePickLocalFiles } = filePicker;
    const { openGitHubPicker, repositoryProvider } = referencePicker;
    const {
        handleAbort, autocompleteOverlayPosition, dictationHeightHostRef, dictationContentHeight,
        dictationHeightLimit, useCompactChatPlaceholder, handleDictationContentHeightChange,
    } = editorActions;
    const {
        handleCommandSelect, handleSkillSelect, handleSnippetSelect, snippetDraftText,
        handleSnippetDraftSaved, handleFileSelect, handleAgentSelect, handleSessionSelect,
        handleExtensionMentionSelect, handleEmojiSelect,
    } = completions;
    const {
        handleDropCapture, handleDragEnter, handleDragOver, handleDragLeave, handleDrop, handleDragEnd,
    } = fileDrop;
    const { parallel, parallelProjectRef, handleRunInParallel, parallelRun } = parallelControls;
    const {
        handleEditorChange, handleEditorKeyDown, handleEditorKeyUp, handleEditorSelectionChange,
        handleEditorBlur,
    } = editorHandlers;
    const { handlePaste } = paste;
    const { handleDictationInsert, handleDictationInsertAndSend, markDictationStart } = dictation;
    const {
        effectiveBtwSelection, btwModelSelectorOpen, setBtwModelSelectorOpen, pinnedComposerSelection,
    } = selection;

    return (
        <form
            ref={setPromptHistorySearchForm}
            data-prompt-history-search-owner="true"
            data-btw-composer={isBtwActive ? 'true' : undefined}
            onContextMenuCapture={() => largeTextPasteGesture.invalidate()}
            onPointerDownCapture={claimAttachmentSlot}
            onFocusCapture={claimAttachmentSlot}
            onDragEnterCapture={claimAttachmentSlot}
            onKeyDownCapture={(event) => {
                if (!isBtwActive || event.key !== 'Escape' || isIMECompositionEvent(event) || hasOpenDropdown()) return;
                if (!(event.target instanceof Element) || !event.target.closest('[data-chat-input-footer]')) return;
                event.preventDefault();
                event.stopPropagation();
                handleExitBtw();
            }}
            onSubmit={(e) => {
                e.preventDefault();
                if (isPromptHistorySearchOpen) return;
                if (mobileCommentActive) {
                    attachMobileCommentRef.current();
                    return;
                }
                handlePrimaryAction();
            }}
            className={cn(
                "relative w-full pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobileExpanded && 'flex h-full min-h-0 flex-col pt-2',
                isMobile && 'bottom-safe-area oc-mobile-composer'
            )}
            style={isMobile && inputBarOffset > 0 ? { marginBottom: `${inputBarOffset}px` } : undefined}
        >
            {showDesktopDraftPresentation ? (
                <div className={cn('chat-input-column mb-7 text-center', draftPresentationClassName)}>
                    <h1 className="text-balance text-2xl font-normal tracking-tight text-foreground md:text-3xl">
                        {renderDraftTitle(draftHeading, draftProjectLabel)}
                    </h1>
                </div>
            ) : null}
            <div className={cn('chat-input-column relative overflow-visible', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                {!mobileCommentActive ? (<>
                {!isMobile && (showDraftTargetSelectors || draftPresentationExiting) && selectedDraftProject ? (
                    <div className={draftPresentationClassName}>
                        <DraftTargetSelectors
                            projects={draftProjects}
                            selectedProject={selectedDraftProject}
                            selectedDirectory={selectedDraftDirectory}
                            selectedBranchLabel={selectedDraftBranchLabel}
                            selectedBranchIsKnown={selectedDraftBranchIsKnown}
                            hasUncommittedChanges={selectedDraftDirectoryHasUncommittedChanges}
                            projectRootBranchOption={projectRootBranchOption}
                            worktreeBranchOptions={worktreeBranchOptions}
                            spaceBranchOptions={spaceBranchOptions}
                            branchItems={draftBranchItems}
                            showBranchSelector={shouldShowDraftBranchSelector}
                            onProjectChange={handleDraftProjectChange}
                            onDirectoryChange={handleDraftDirectoryChange}
                            onRefreshTarget={refreshDraftTarget}
                            onCreateSpace={handleCreateSpace}
                            onCreateCustomWorktree={handleCreateCustomWorktree}
                            theme={currentTheme}
                        />
                    </div>
                ) : null}
                {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
                    <MobileDraftTargetTriggers
                        selectedProject={selectedDraftProject}
                        selectedBranchLabel={selectedDraftBranchLabel}
                        showBranchSelector={shouldShowDraftBranchSelector}
                        theme={currentTheme}
                        onOpenPicker={handleMobileDraftPickerChange}
                    />
                ) : null}
                </>) : null}
                <div
                    data-dictation-host="true"
                    className={cn(
                        !isMobile && 'contents',
                        isMobile && 'relative',
                        isMobileExpanded && 'flex min-h-0 flex-1 flex-col',
                    )}
                >
                {messageSelectionActive && currentSessionId ? (
                    <MessageSelectionBar
                        sessionId={currentSessionId}
                        directory={chatColumnSession?.directory ?? currentSessionDirectoryForSync ?? currentDirectory ?? null}
                        isMobile={isMobile}
                        radius={chatInputRadius}
                    />
                ) : mobileCommentActive && mobileComment.draft.status === 'open' ? (
                    <MobileCommentComposer
                        key={mobileComment.draft.generation}
                        draft={mobileComment.draft}
                        theme={currentTheme}
                        handlers={mobileComment.handlers}
                    />
                ) : isMobile && !mobileComposerExpanded && !isBtwActive ? (
                    <MobilePillComposer
                        message={pillText}
                        messageContent={withAttachmentChips(pillText, attachmentFilenames, 'pill')}
                        sessionId={currentSessionId}
                        newSessionDraftOpen={newSessionDraftOpen}
                        hasContent={Boolean(hasContent) && !pendingFirstSend}
                        isVSCode={isVSCode}
                        canAbort={canAbort}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        topRow={composerTopRows}
                        attachments={(
                            contextRows ? <div className="px-3 pt-1">{contextRows}</div> : null
                        )}
                        bottomRow={mobileModelAgentRow}
                        onExpand={mobileShell.expand}
                        onPrimaryAction={handlePrimaryAction}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenGitHubPicker={openGitHubPicker}
                        repositoryProvider={repositoryProvider}
                        trackerPickers={trackerPickers}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onStartDictation={toggleDictation}
                        onAbort={handleAbort}
                    />
                ) : (
                <>
                <div
                    className={cn('relative', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                >
                    {largeTextPasteOffer ? (
                        <LargeTextPasteChoice
                            key={largeTextPasteOffer.id}
                            takeFocus={!isMobile}
                            expanded={isComposerExpanded}
                            onChoose={(action, explicitlyChosen) => largeTextPasteOffer.resolve(action, explicitlyChosen)}
                            onTypeThrough={(text) => largeTextPasteOffer.resolve('inline', true, text)}
                        />
                    ) : null}
                    <ComposerAutocompletePopups
                        open={openAutocomplete}
                        query={autocompleteQuery}
                        overlayPosition={autocompleteOverlayPosition}
                        commandRef={commandRef}
                        skillRef={skillRef}
                        snippetRef={snippetRef}
                        mentionRef={mentionRef}
                        emojiRef={emojiRef}
                        onCommandSelect={handleCommandSelect}
                        onSkillSelect={handleSkillSelect}
                        onSnippetSelect={handleSnippetSelect}
                        snippetDraftText={snippetDraftText}
                        onSnippetDraftSaved={handleSnippetDraftSaved}
                        onFileSelect={handleFileSelect}
                        onAgentSelect={handleAgentSelect}
                        onSessionSelect={isVSCode ? undefined : handleSessionSelect}
                        onExtensionMentionSelect={isVSCode || isBtwActive ? undefined : handleExtensionMentionSelect}
                        currentSessionId={currentSessionId}
                        onEmojiSelect={handleEmojiSelect}
                        onClose={closeAutocomplete}
                    />
                <div
                    className={cn(
                        'flex flex-col',
                        isComposerExpanded && 'relative flex-1 min-h-0',
                    )}
                    style={{ borderRadius: chatInputRadius }}
                >
                <div
                    className={cn(isComposerExpanded ? 'absolute inset-s-0 inset-e-0 bottom-0 h-0' : 'relative h-0')}
                    data-prompt-history-search-anchor
                >
                    {isPromptHistorySearchOpen && promptHistorySearch ? (
                        <PromptHistorySearchPanel
                            history={historyValues}
                            initialQuery={promptHistorySearch.initialQuery}
                            olderRequest={promptHistorySearch.olderRequest}
                            onPick={pickPromptHistoryCandidate}
                            onClose={closePromptHistorySearch}
                        />
                    ) : null}
                </div>
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isComposerExpanded && 'flex-1 min-h-0',
                        'oc-surface-floating oc-composer-surface',
                        isDragging ? "ring-2 ring-primary ring-offset-2" : 'oc-glass-floating oc-composer-sheen',
                    )}
                    style={{ borderRadius: chatInputRadius }}
                    ref={dropZoneRef}
                    data-composer-box={isMobile ? 'true' : undefined}
                    data-dictating={desktopDictating && !isMobile && !isBtwActive ? 'true' : undefined}
                    onDropCapture={handleDropCapture}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                >
                    {isDragging && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 rounded-xl">
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title={t('chat.chatInput.actions.attachFiles')}
                                        aria-label={t('chat.chatInput.actions.attachFiles')}
                                    >
                                        <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">
                                    {isInternalDrag ? t('chat.chatInput.drop.insertMention') : t('chat.chatInput.drop.attachFiles')}
                                </p>
                            </div>
                        </div>
                    )}

                    <div className={cn('relative flex flex-col', isComposerExpanded && 'flex-1 min-h-0')} data-dictation-chain="true">
                    <div className={cn("overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                        {parallel.isActive ? <ParallelComposerStrip parallel={parallel} project={parallelProjectRef} /> : null}
                        {composerTopRows}
                        {isVSCode && !isBtwActive ? (
                            <div className="flex items-center gap-1 px-3 pt-1 flex-wrap relative z-10">
                                <ActiveEditorFileSuggestion />
                            </div>
                        ) : null}
                        {contextRows ? <div className="relative z-10 px-1.5">{contextRows}</div> : null}
                        <div
                            ref={dictationHeightHostRef}
                            className={cn("relative overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                            data-composer-morph-prompt={isMobile ? 'true' : undefined}
                            onDragEnter={handleDragEnter}
                            onDragOver={handleDragOver}
                            onDropCapture={handleDropCapture}
                            onDrop={handleDrop}
                            onDragEnd={handleDragEnd}
                            style={dictationContentHeight !== null && !isComposerExpanded
                                ? {
                                    minHeight: `${Math.min(
                                        dictationContentHeight,
                                        dictationHeightLimit ?? dictationContentHeight,
                                    )}px`,
                                }
                                : undefined}
                        >
                            <ComposerEditor
                                ref={composerRef}
                                viewStore={composerViewStore}
                                data-testid="chat-input"
                                value={composerText.get()}
                                valueRevision={editorValueRevision}
                                languageContext={languageContext}
                                onChange={handleEditorChange}
                                onKeyDown={handleEditorKeyDown}
                                onPaste={handlePaste}
                                onKeyUp={handleEditorKeyUp}
                                onSelectionChange={handleEditorSelectionChange}
                                onFocus={mobileShell.onEditorFocus}
                                onBlur={handleEditorBlur}
                                placeholder={isBtwActive
                                    ? t('chat.btw.mainComposerPlaceholder')
                                    : currentSessionId || newSessionDraftOpen
                                        ? inputMode === 'shell'
                                            ? t('chat.chatInput.placeholder.shell')
                                            : t(useCompactChatPlaceholder ? 'chat.chatInput.placeholder.chatCompact' : 'chat.chatInput.placeholder.chat')
                                        : t('chat.chatInput.placeholder.selectSession')}
                                editable={Boolean(currentSessionId || newSessionDraftOpen)}
                                autoCorrect={composerAutoCorrect({ isMobile })}
                                autoCapitalize={isMobile ? 'sentences' : 'none'}
                                preserveDeferredEnterShift={shouldPreserveDeferredEnterShift({ isMobile, hasHardwareKeyboard })}
                                returnKeySends={isMobile && mobileReturnKeySends}
                                spellCheck={isMobile || inputSpellcheckEnabled}
                                fillContainer={isComposerExpanded}
                                maxLines={isMobile ? MAX_MOBILE_COMPOSER_LINES : MAX_VISIBLE_COMPOSER_LINES}
                                boundSelector={isMobile ? '[data-composer-bound]' : undefined}
                                boundGapPx={MOBILE_COMPOSER_BOUND_GAP_PX}
                                className={cn(
                                    'min-h-[52px] px-3 relative z-10',
                                    isComposerExpanded
                                        ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4')
                                        : isMobile
                                            ? 'pt-4 pb-2.5'
                                            : 'pt-4 pb-2',
                                    inputMode === 'shell' ? 'font-mono' : 'typography-markdown md:typography-ui-label',
                                )}
                            />
                        </div>
                    </div>
                    <ComposerFooter
                        isMobile={isMobile}
                        isVSCode={isVSCode}
                        escapeStops={abortShortcutReaches}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        messageLength={goalObjectiveLength}
                        radius={chatInputRadius}
                        footerPaddingClass={footerPaddingClass}
                        footerGapClass={footerGapClass}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        canSend={canSend}
                        canAbort={canAbort}
                        hasContent={Boolean(hasContent)}
                        permissionMode={shownPermissionMode}
                        isPermissionAutoAcceptInteractive={isPermissionAutoAcceptInteractive}
                        dictationActive={mobileShell.dictationActive}
                        onOpenSettings={onOpenSettings}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenGitHubPicker={openGitHubPicker}
                        repositoryProvider={repositoryProvider}
                        trackerPickers={trackerPickers}
                        attachGuests={isMobile ? NO_ATTACH_GUESTS : guestAttachItems}
                        onOpenGuestAttach={openGuestAttach}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onCyclePermissionMode={handlePermissionModeCycle}
                        onPrimaryAction={handlePrimaryAction}
                        onAbort={handleAbort}
                        onStartDictation={toggleDictation}
                        onDictationInsert={handleDictationInsert}
                        onDictationInsertAndSend={handleDictationInsertAndSend}
                        onDictationSendStart={handleDictationSendStart}
                        onDictationStart={markDictationStart}
                        onDictationContentHeightChange={handleDictationContentHeightChange}
                        onDictationActiveChange={setDesktopDictating}
                        isBtw={isBtwActive}
                        modelSessionId={btwComposerSessionId}
                        btwSelection={effectiveBtwSelection}
                        btwModelSelectorOpen={btwModelSelectorOpen}
                        onBtwModelSelectorOpenChange={setBtwModelSelectorOpen}
                        pinnedSelection={pinnedComposerSelection}
                        onRunInParallel={!isMobile && !isBtwActive && !columnPinned ? handleRunInParallel : undefined}
                        parallelRun={parallelRun}
                        waitingForOpenCode={waitingForOpenCode}
                    />
                    {mobileModelAgentRow}
                    </div>

                </div>
                </div>
                </div>
                </>
                )}
                {isMobile && !isBtwActive && !mobileCommentActive && !messageSelectionActive ? (
                    <MemoComposerDictation
                        radius={chatInputRadius}
                        isMobile={isMobile}
                        footerIconButtonClass={footerIconButtonClass}
                        footerPaddingClass={footerPaddingClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        onInsert={handleDictationInsert}
                        onInsertAndSend={handleDictationInsertAndSend}
                        onSendStart={handleDictationSendStart}
                        onStart={markDictationStart}
                        onActiveChange={handleDictationActiveChange}
                        onContentHeightChange={handleDictationContentHeightChange}
                        renderTrigger={false}
                    />
                ) : null}
                </div>
                {isMobile && !isBtwActive ? (
                    <MemoModelControls
                        className="hidden"
                        mobilePanel={mobileControlsPanel}
                        onMobilePanelChange={setMobileControlsPanel}
                    />
                ) : null}
            </div>
            {showDesktopDraftPresentation && selectedDraftProject && selectedDraftProject.kind !== 'chat' ? (
                <DraftPresetChips
                    onSubmit={handlePresetChipSubmit}
                    className={cn('chat-input-column mt-4', draftPresentationClassName)}
                />
            ) : null}
            <PermissionDock
                sessionId={currentSessionId}
                directory={currentSessionDirectoryForSync ?? currentDirectory ?? undefined}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible || isPromptHistorySearchOpen}
            />
            <FormDock
                sessionId={currentSessionId}
                directory={currentSessionDirectoryForSync ?? currentDirectory ?? undefined}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible || hasPendingPermission || isPromptHistorySearchOpen}
            />
            {currentSessionId ? <BtwPanel parentSessionId={currentSessionId} panel={btwPanel} hidden={!isBtwPanelVisible} onExit={handleExitBtw} /> : null}
        </form>
    );
}
