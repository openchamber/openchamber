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
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerMobileActions } from './useComposerMobileActions';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerSendActions } from './useComposerSendActions';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerDraftTarget } from './useComposerDraftTarget';
import type { ChatInputProps } from './chatInputProps';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerControls } from './useComposerControls';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerReferenceActions } from './useComposerReferenceActions';
import type { useComposerRows } from './useComposerRows';
import type { useComposerFilePicker } from './useComposerFilePicker';
import type { useComposerReferencePicker } from './useComposerReferencePicker';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerCompletions } from './useComposerCompletions';
import type { useComposerFileDrop } from './useComposerFileDrop';
import type { useComposerParallelRun } from './useComposerParallelRun';
import type { useComposerEditorHandlers } from './useComposerEditorHandlers';
import type { useComposerPaste } from './useComposerPaste';
import type { useComposerDictation } from './useComposerDictation';
import type { useComposerSelection } from './useComposerSelection';
import { renderDraftTitle } from './ComposerDraftTitle';
import { MAX_MOBILE_COMPOSER_LINES, MAX_VISIBLE_COMPOSER_LINES, MOBILE_COMPOSER_BOUND_GAP_PX } from './composerInputLimits';
import { MemoComposerDictation, MemoModelControls } from './memoComposerControls';

const NO_ATTACH_GUESTS: [] = [];

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 'setPromptHistorySearchForm' | 'largeTextPasteGesture' | 'chatColumnSession' | 'largeTextPasteOffer' | 'openAutocomplete' | 'autocompleteQuery' | 'commandRef' | 'skillRef' | 'snippetRef' | 'mentionRef' | 'emojiRef' | 'closeAutocomplete' | 'promptHistorySearch' | 'isDragging' | 'dropZoneRef' | 't' | 'isInternalDrag' | 'composerRef' | 'composerViewStore' | 'composerText' | 'editorValueRevision' | 'columnPinned' | 'mobileControlsPanel' | 'setMobileControlsPanel'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'claimAttachmentSlot' | 'messageSelectionActive' | 'currentSessionId' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'newSessionDraftOpen' | 'inputMode' | 'btwComposerSessionId' | 'isBtwPanelVisible' | 'hasPendingPermission' | 'btwPanel'>
    & Pick<ReturnType<typeof useComposerSessionLifecycle>, 'handleExitBtw'>
    & Pick<ReturnType<typeof useComposerDraftHistory>, 'isPromptHistorySearchOpen' | 'historyValues'>
    & Pick<ReturnType<typeof useComposerMobileActions>, 'mobileCommentActive' | 'mobileComment' | 'pickPromptHistoryCandidate' | 'closePromptHistorySearch' | 'handleDictationSendStart' | 'handleDictationActiveChange'>
    & Pick<ReturnType<typeof useComposerInlineContext>, 'attachMobileCommentRef'>
    & Pick<ReturnType<typeof useComposerSendActions>, 'handlePrimaryAction' | 'handlePresetChipSubmit'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'isDesktopExpanded' | 'isMobileExpanded' | 'isMobile' | 'inputBarOffset' | 'isComposerExpanded' | 'currentTheme' | 'chatInputRadius' | 'hasHardwareKeyboard' | 'mobileReturnKeySends' | 'inputSpellcheckEnabled'>
    & Pick<ReturnType<typeof useComposerDraftTarget>, 'showDesktopDraftPresentation' | 'draftPresentationClassName' | 'draftHeading' | 'draftProjectLabel' | 'showDraftTargetSelectors' | 'selectedDraftProject' | 'draftProjects' | 'selectedDraftDirectory' | 'selectedDraftBranchLabel' | 'selectedDraftBranchIsKnown' | 'selectedDraftDirectoryHasUncommittedChanges' | 'projectRootBranchOption' | 'worktreeBranchOptions' | 'spaceBranchOptions' | 'draftBranchItems' | 'shouldShowDraftBranchSelector' | 'handleDraftProjectChange' | 'handleDraftDirectoryChange' | 'refreshDraftTarget' | 'handleCreateSpace' | 'handleCreateCustomWorktree' | 'handleMobileDraftPickerChange' | 'abortShortcutReaches'>
    & Pick<ChatInputProps, 'draftPresentationExiting' | 'onOpenSettings'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'mobileComposerExpanded' | 'mobileShell'>
    & Pick<ReturnType<typeof useComposerControls>, 'pillText' | 'footerIconButtonClass' | 'iconSizeClass' | 'sendIconSizeClass' | 'stopIconSizeClass' | 'openMobileAttachSheet' | 'toggleDictation' | 'desktopDictating' | 'iconButtonBaseClass' | 'goalObjectiveLength' | 'footerPaddingClass' | 'shownPermissionMode' | 'isPermissionAutoAcceptInteractive' | 'handlePermissionModeCycle' | 'setDesktopDictating' | 'waitingForOpenCode'>
    & Pick<ReturnType<typeof useComposerLanguage>, 'attachmentFilenames' | 'languageContext'>
    & Pick<ReturnType<typeof useComposerSendAvailability>, 'hasContent' | 'pendingFirstSend' | 'canAbort' | 'canSend'>
    & Pick<ReturnType<typeof useComposerReferenceActions>, 'isVSCode' | 'trackerPickers' | 'footerGapClass' | 'guestAttachItems' | 'openGuestAttach'>
    & Pick<ReturnType<typeof useComposerRows>, 'composerTopRows' | 'contextRows' | 'mobileModelAgentRow'>
    & Pick<ReturnType<typeof useComposerFilePicker>, 'handlePickLocalFiles'>
    & Pick<ReturnType<typeof useComposerReferencePicker>, 'openGitHubPicker' | 'repositoryProvider'>
    & Pick<ReturnType<typeof useComposerEditorActions>, 'handleAbort' | 'autocompleteOverlayPosition' | 'dictationHeightHostRef' | 'dictationContentHeight' | 'dictationHeightLimit' | 'useCompactChatPlaceholder' | 'handleDictationContentHeightChange'>
    & Pick<ReturnType<typeof useComposerCompletions>, 'handleCommandSelect' | 'handleSkillSelect' | 'handleSnippetSelect' | 'snippetDraftText' | 'handleSnippetDraftSaved' | 'handleFileSelect' | 'handleAgentSelect' | 'handleSessionSelect' | 'handleExtensionMentionSelect' | 'handleEmojiSelect'>
    & Pick<ReturnType<typeof useComposerFileDrop>, 'handleDropCapture' | 'handleDragEnter' | 'handleDragOver' | 'handleDragLeave' | 'handleDrop' | 'handleDragEnd'>
    & Pick<ReturnType<typeof useComposerParallelRun>, 'parallel' | 'parallelProjectRef' | 'handleRunInParallel' | 'parallelRun'>
    & Pick<ReturnType<typeof useComposerEditorHandlers>, 'handleEditorChange' | 'handleEditorKeyDown' | 'handleEditorKeyUp' | 'handleEditorSelectionChange' | 'handleEditorBlur'>
    & Pick<ReturnType<typeof useComposerPaste>, 'handlePaste'>
    & Pick<ReturnType<typeof useComposerDictation>, 'handleDictationInsert' | 'handleDictationInsertAndSend' | 'markDictationStart'>
    & Pick<ReturnType<typeof useComposerSelection>, 'effectiveBtwSelection' | 'btwModelSelectorOpen' | 'setBtwModelSelectorOpen' | 'pinnedComposerSelection'>;

export function renderComposerForm({
    setPromptHistorySearchForm, isBtwActive, largeTextPasteGesture, claimAttachmentSlot, handleExitBtw,
    isPromptHistorySearchOpen, mobileCommentActive, attachMobileCommentRef, handlePrimaryAction,
    isDesktopExpanded, isMobileExpanded, isMobile, inputBarOffset, showDesktopDraftPresentation,
    draftPresentationClassName, draftHeading, draftProjectLabel, isComposerExpanded,
    showDraftTargetSelectors, draftPresentationExiting, selectedDraftProject, draftProjects,
    selectedDraftDirectory, selectedDraftBranchLabel, selectedDraftBranchIsKnown,
    selectedDraftDirectoryHasUncommittedChanges, projectRootBranchOption, worktreeBranchOptions,
    spaceBranchOptions, draftBranchItems, shouldShowDraftBranchSelector, handleDraftProjectChange,
    handleDraftDirectoryChange, refreshDraftTarget, handleCreateSpace, handleCreateCustomWorktree,
    currentTheme, handleMobileDraftPickerChange, messageSelectionActive, currentSessionId, chatColumnSession,
    currentSessionDirectoryForSync, currentDirectory, chatInputRadius, mobileComment, mobileComposerExpanded,
    pillText, attachmentFilenames, newSessionDraftOpen, hasContent, pendingFirstSend, isVSCode, canAbort,
    footerIconButtonClass, iconSizeClass, sendIconSizeClass, stopIconSizeClass, composerTopRows, contextRows,
    mobileModelAgentRow, mobileShell, handlePickLocalFiles, openGitHubPicker, repositoryProvider,
    trackerPickers, openMobileAttachSheet, toggleDictation, handleAbort, largeTextPasteOffer,
    openAutocomplete, autocompleteQuery, autocompleteOverlayPosition, commandRef, skillRef, snippetRef,
    mentionRef, emojiRef, handleCommandSelect, handleSkillSelect, handleSnippetSelect, snippetDraftText,
    handleSnippetDraftSaved, handleFileSelect, handleAgentSelect, handleSessionSelect,
    handleExtensionMentionSelect, handleEmojiSelect, closeAutocomplete, promptHistorySearch, historyValues,
    pickPromptHistoryCandidate, closePromptHistorySearch, isDragging, dropZoneRef, desktopDictating,
    handleDropCapture, handleDragEnter, handleDragOver, handleDragLeave, handleDrop, handleDragEnd,
    iconButtonBaseClass, t, isInternalDrag, parallel, parallelProjectRef, dictationHeightHostRef,
    dictationContentHeight, dictationHeightLimit, composerRef, composerViewStore, composerText,
    editorValueRevision, languageContext, handleEditorChange, handleEditorKeyDown, handlePaste,
    handleEditorKeyUp, handleEditorSelectionChange, handleEditorBlur, inputMode, useCompactChatPlaceholder,
    hasHardwareKeyboard, mobileReturnKeySends, inputSpellcheckEnabled, abortShortcutReaches,
    goalObjectiveLength, footerPaddingClass, footerGapClass, canSend, shownPermissionMode,
    isPermissionAutoAcceptInteractive, onOpenSettings, guestAttachItems, openGuestAttach,
    handlePermissionModeCycle, handleDictationInsert, handleDictationInsertAndSend, handleDictationSendStart,
    markDictationStart, handleDictationContentHeightChange, setDesktopDictating, btwComposerSessionId,
    effectiveBtwSelection, btwModelSelectorOpen, setBtwModelSelectorOpen, pinnedComposerSelection,
    columnPinned, handleRunInParallel, parallelRun, waitingForOpenCode, handleDictationActiveChange,
    mobileControlsPanel, setMobileControlsPanel, handlePresetChipSubmit, isBtwPanelVisible,
    hasPendingPermission, btwPanel,
}: Dependencies) {
    return (
        <><form
            ref={setPromptHistorySearchForm}
            data-prompt-history-search-owner="true"
            data-btw-composer={isBtwActive ? 'true' : undefined}
            onContextMenuCapture={() => largeTextPasteGesture.invalidate()}
            // Whichever composer the user works in holds the selected
            // attachment slot, so its paste, drop, picker and remove act on
            // its own files when a second chat is open beside it.
            onPointerDownCapture={claimAttachmentSlot}
            onFocusCapture={claimAttachmentSlot}
            onDragEnterCapture={claimAttachmentSlot}
            onKeyDownCapture={(event) => {
                if (!isBtwActive || event.key !== 'Escape' || isIMECompositionEvent(event) || hasOpenDropdown()) return;
                if (!(event.target instanceof Element) || !event.target.closest('[data-chat-input-footer]')) return;
                // Footer tooltips must not consume the only exit key for a pending BTW.
                event.preventDefault();
                event.stopPropagation();
                handleExitBtw();
            }}
            onSubmit={(e) => {
                e.preventDefault();
                if (isPromptHistorySearchOpen) return;
                // Comment mode owns the form: submit attaches the comment and
                // must never reach the send path.
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
                {/* Comment mode shows only its own shell: the normal composer's
                    furniture (chips, banners, draft selectors) stays in state
                    and returns unchanged when the comment exits. */}
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
                    // Desktop: layout-transparent. Mobile: positioning host for
                    // the wrapper-level dictation overlay across pill/full states.
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
                    // Keyed by generation: a replaced open remounts the shell
                    // so its dictation callbacks can never target the
                    // previous quote.
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
                {/* The autocomplete popups anchor to this wrapper, not to the
                    box, which clips its contents. */}
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
                        // VS Code shows no reference chips, so it cannot hold one.
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
                {/* Normal: zero-height row above the composer box. Expanded: the
                    box grows to fill the column, so the anchor is pinned to the
                    box's bottom edge instead of flowing before it. */}
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
                        // Opaque: always on screen over the moving transcript
                        // (see .oc-surface-floating in design-system.css).
                        'oc-surface-floating oc-composer-surface',
                        // Lit like a dropdown (top edge, hairline, shadow). Its
                        // box-shadow would hide the drag ring, so it steps aside
                        // while a file is dragged over.
                        isDragging ? "ring-2 ring-primary ring-offset-2" : 'oc-glass-floating oc-composer-sheen',
                    )}
                    style={{ borderRadius: chatInputRadius }}
                    ref={dropZoneRef}
                    // The mobile pill morph measures and animates this box.
                    data-composer-box={isMobile ? 'true' : undefined}
                    // The desktop dictation overlay is up: the box hides its
                    // other contents (see design-system.css).
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

                    {/* Positioning context for the dictation overlay: covers the
                        text area + footer exactly. */}
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
                            // The mobile pill morph moves this block from the
                            // pill's text line and unfurls it.
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
                                // Read at render: the editor's own text, unless the app
                                // just put new text in (see `setMessage`).
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
                {/* Wrapper-level dictation engine + overlay: stays mounted across
                    the pill ↔ composer swap so a recording started from the pill
                    survives the morph. Its absolute overlay covers whichever
                    shape the wrapper currently has. NOT mounted during comment
                    mode: the comment shell runs its own comment-scoped engine,
                    so the form's dictation events belong to that engine.
                    An in-flight recording is discarded by the swap:
                    its transcript must never reach the normal draft. */}
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
                {/* Hidden host for the model/agent/variant bottom sheets. Kept
                    outside the pill conditional so an open panel survives (and
                    stays visible over) the collapsed composer. */}
                {isMobile && !isBtwActive ? (
                    <MemoModelControls
                        className="hidden"
                        mobilePanel={mobileControlsPanel}
                        onMobilePanelChange={setMobileControlsPanel}
                    />
                ) : null}
            </div>
            {/* Starters act on a project ("Explore the codebase"), so they wait
                until the draft has one: without a project the target is the
                chat stand-in, shown as "Choose project". */}
            {showDesktopDraftPresentation && selectedDraftProject && selectedDraftProject.kind !== 'chat' ? (
                <DraftPresetChips
                    onSubmit={handlePresetChipSubmit}
                    className={cn('chat-input-column mt-4', draftPresentationClassName)}
                />
            ) : null}
            {/* One floating panel at a time: an open BTW, then a permission,
                then the form, then a collapsed BTW strip. */}
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
        </form></>
    );
}
