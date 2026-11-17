import React from 'react';
import { ProviderIcon } from '@/components/sourceControl/ProviderIcon';
import { ReviewFlowDialog } from '@/components/session/ReviewFlowDialog';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow } from '@/components/ui/MobileSheetList';
import { ReferencePickerDialog } from '@/components/references/ReferencePickerDialog';
import { composerReferenceKey, withComposerReferences } from '../../composer/composerReferences';
import { MobileDraftTargetSheets } from '../../composer/ui/DraftTargetSelectors';
import { NewSpaceDialog } from '@/components/session/spaces/NewSpaceDialog';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { SharedPageCardDialog } from '../../sharePages/received/SharedPageCardDialog';
import { SharedPageChip } from '../../sharePages/received/SharedPageChip';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerReferencePicker } from './useComposerReferencePicker';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerReferenceActions } from './useComposerReferenceActions';
import type { useComposerFilePicker } from './useComposerFilePicker';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerDraftTarget } from './useComposerDraftTarget';
import { AttachmentPickerInput } from './ComposerAttachmentPickerInput';
import { GuestAttachDialog, ToolOutputDialog } from './ComposerLazyDialogs';

type Dependencies = Pick<ReturnType<typeof useComposerMobileShell>, 'referencePicker' | 'setReferencePicker' | 'mobileShell'>
    & Pick<ReturnType<typeof useComposerLanguage>, 'referencePickerDirectory' | 'linkedReferences' | 'openSharedPageKey' | 'setOpenSharedPageKey'>
    & Pick<ReturnType<typeof useComposerReferencePicker>, 'attachReferences' | 'repositoryDescriptor' | 'openGitHubPicker'>
    & Pick<ReturnType<typeof useComposerReferenceDrafts>, 'attachDialogGuestId' | 'attachDialogItem' | 'setAttachDialogGuestId' | 'setAttachDialogItem' | 'updateLinkedReferences'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'reviewDialogMounted' | 'reviewDialogOpen' | 'setReviewDialogOpen' | 'currentSessionDirectoryForSync' | 'currentDirectory'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'reviewFlowSubmitting' | 'handleStartReviewFlow' | 'attachmentPreviewMounted' | 'attachmentPreview' | 'handleAttachmentPreviewOpenChange' | 'isMobile' | 'currentTheme'>
    & Pick<ReturnType<typeof useComposerReferenceActions>, 'openSharedPage' | 'trackerPickers' | 'guestAttachItems' | 'openGuestAttach'>
    & Pick<ReturnType<typeof useComposerFilePicker>, 'fileInputRef' | 'handleLocalFileSelect' | 'handlePickLocalFiles'>
    & Pick<ReturnType<typeof useComposerInputState>, 'mobileAttachMenuOpen' | 't' | 'setMobileAttachMenuOpen' | 'mobileDraftPicker'>
    & Pick<ReturnType<typeof useComposerDraftTarget>, 'showDraftTargetSelectors' | 'selectedDraftProject' | 'draftProjects' | 'selectedDraftDirectory' | 'selectedDraftBranchLabel' | 'selectedDraftBranchIsKnown' | 'selectedDraftDirectoryHasUncommittedChanges' | 'projectRootBranchOption' | 'worktreeBranchOptions' | 'spaceBranchOptions' | 'draftBranchItems' | 'shouldShowDraftBranchSelector' | 'handleDraftProjectChange' | 'handleDraftDirectoryChange' | 'handleCreateSpace' | 'handleCreateCustomWorktree' | 'handleMobileDraftPickerChange' | 'newSpaceProject' | 'setNewSpaceProject' | 'newWorktreeProject' | 'setNewWorktreeProject' | 'handleCustomWorktreeCreated'>;

export function renderComposerDialogs({
    referencePicker, setReferencePicker, referencePickerDirectory, attachReferences, attachDialogGuestId,
    attachDialogItem, setAttachDialogGuestId, setAttachDialogItem, reviewDialogMounted, reviewDialogOpen,
    setReviewDialogOpen, currentSessionDirectoryForSync, currentDirectory, reviewFlowSubmitting,
    handleStartReviewFlow, linkedReferences, openSharedPageKey, updateLinkedReferences, openSharedPage,
    setOpenSharedPageKey, attachmentPreviewMounted, attachmentPreview, handleAttachmentPreviewOpenChange,
    isMobile, fileInputRef, handleLocalFileSelect, mobileAttachMenuOpen, t, setMobileAttachMenuOpen,
    mobileShell, handlePickLocalFiles, repositoryDescriptor, openGitHubPicker, trackerPickers,
    guestAttachItems, openGuestAttach, showDraftTargetSelectors, selectedDraftProject, draftProjects,
    selectedDraftDirectory, selectedDraftBranchLabel, selectedDraftBranchIsKnown,
    selectedDraftDirectoryHasUncommittedChanges, projectRootBranchOption, worktreeBranchOptions,
    spaceBranchOptions, draftBranchItems, shouldShowDraftBranchSelector, handleDraftProjectChange,
    handleDraftDirectoryChange, handleCreateSpace, handleCreateCustomWorktree, currentTheme,
    mobileDraftPicker, handleMobileDraftPickerChange, newSpaceProject, setNewSpaceProject,
    newWorktreeProject, setNewWorktreeProject, handleCustomWorktreeCreated,
}: Dependencies) {
    return (
        <>

        {referencePicker ? (
            <ReferencePickerDialog
                open
                onOpenChange={(open) => {
                    if (!open) setReferencePicker(null);
                }}
                source={referencePicker.source}
                purpose="attach"
                selection="multiple"
                directory={referencePickerDirectory}
                initialGitHubKind={referencePicker.source === 'repository' ? referencePicker.kind : undefined}
                onConfirm={attachReferences}
            />
        ) : null}
        {attachDialogGuestId ? (
            <React.Suspense fallback={null}>
                <GuestAttachDialog
                    guestId={attachDialogGuestId}
                    item={attachDialogItem}
                    onOpenChange={(open) => {
                        if (!open) {
                            setAttachDialogGuestId(null);
                            setAttachDialogItem(null);
                        }
                    }}
                />
            </React.Suspense>
        ) : null}
        {reviewDialogMounted ? <ReviewFlowDialog
            open={reviewDialogOpen}
            onOpenChange={setReviewDialogOpen}
            projectDirectory={currentSessionDirectoryForSync ?? currentDirectory ?? null}
            submitting={reviewFlowSubmitting}
            onConfirm={handleStartReviewFlow}
        /> : null}
        {/* A shared page reads the server whether or not its card is open: the
            id its link got, its state, and once opened, the page the agent gets
            (a page added from Pages may already be open). The card shows the
            same chip; this copy stays out of sight. */}
        <div hidden>
            {linkedReferences.flatMap((reference) => (
                reference.kind === 'shared-page' && composerReferenceKey(reference) !== openSharedPageKey
                    ? [<SharedPageChip
                        key={composerReferenceKey(reference)}
                        reference={reference}
                        onChange={(next) => updateLinkedReferences((current) => withComposerReferences(current, [next]))}
                    />]
                    : []
            ))}
        </div>
        <SharedPageCardDialog
            reference={openSharedPage}
            onChange={(next) => updateLinkedReferences((current) => withComposerReferences(current, [next]))}
            onClose={() => setOpenSharedPageKey(null)}
        />

        {attachmentPreviewMounted ? (
            <React.Suspense fallback={null}>
                <ToolOutputDialog
                    popup={attachmentPreview}
                    onOpenChange={handleAttachmentPreviewOpenChange}
                    isMobile={isMobile}
                />
            </React.Suspense>
        ) : null}

        {/* Single always-mounted picker input. It must NOT live inside
            ComposerAttachmentControls: that component mounts once per composer
            variant (pill / expanded footer), so a shared ref got nulled when a
            variant unmounted, and a variant swap while the OS file picker was
            open detached the clicked input — its change event was silently
            lost and the picked files never attached. */}
        <AttachmentPickerInput ref={fileInputRef} onChange={handleLocalFileSelect} />

        {/* Mobile attachment sheet: replaces the dropdown (which stole focus and
            dismissed the keyboard) and leaves room for more actions later. */}
        {isMobile ? (
            <MobileOverlayPanel
                open={mobileAttachMenuOpen}
                title={t('chat.chatInput.actions.addAttachment')}
                onClose={() => setMobileAttachMenuOpen(false)}
            >
                <MobileSheetRow
                    icon="attachment-2"
                    onClick={() => {
                        // The native file/photo picker takes over next — restoring
                        // the keyboard in between would flash it open and shut.
                        mobileShell.cancelOverlayCloseRestore();
                        setMobileAttachMenuOpen(false);
                        requestAnimationFrame(handlePickLocalFiles);
                    }}
                >
                    {t('chat.chatInput.actions.attachFiles')}
                </MobileSheetRow>
                <MobileSheetRow
                    leading={<ProviderIcon descriptor={repositoryDescriptor} className="size-4 flex-shrink-0 text-muted-foreground" />}
                    onClick={() => {
                        // Hand-off to the picker: don't sync-restore the
                        // keyboard under the overlay that opens next frame.
                        mobileShell.skipNextOverlayCloseRestore();
                        setMobileAttachMenuOpen(false);
                        requestAnimationFrame(openGitHubPicker);
                    }}
                >
                    {t(`chat.chatInput.actions.linkRepositoryItem.${repositoryDescriptor.terminology.changeRequest}`, { provider: repositoryDescriptor.label })}
                </MobileSheetRow>
                {trackerPickers.map((picker) => (
                    <MobileSheetRow
                        key={picker.provider}
                        icon={picker.icon}
                        onClick={() => {
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(picker.open);
                        }}
                    >
                        {picker.label}
                    </MobileSheetRow>
                ))}
                {/* Extensions that opted into the phone: a dialog opens full
                    screen, a panel as the extension's workspace tab. */}
                {guestAttachItems.map((guest) => (
                    <MobileSheetRow
                        key={guest.id}
                        leading={<GuestIcon icon={guest.icon} iconSrc={guest.iconSrc} className="size-4 flex-shrink-0 text-muted-foreground" />}
                        onClick={() => {
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(() => openGuestAttach(guest.id));
                        }}
                    >
                        {guest.name}
                    </MobileSheetRow>
                ))}
            </MobileOverlayPanel>
        ) : null}

        {/* Mobile draft target pickers: bottom sheets replacing the inline
            project/branch Selects (which desktop keeps). */}
        {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
            <MobileDraftTargetSheets
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
                onCreateSpace={handleCreateSpace}
                onCreateCustomWorktree={handleCreateCustomWorktree}
                theme={currentTheme}
                openPicker={mobileDraftPicker}
                onOpenPickerChange={handleMobileDraftPickerChange}
            />
        ) : null}
        {newSpaceProject ? (
            <NewSpaceDialog open onOpenChange={(open) => { if (!open) setNewSpaceProject(null); }} project={newSpaceProject} />
        ) : null}
        {newWorktreeProject ? (
            <NewWorktreeDialog
                open
                onOpenChange={(open) => { if (!open) setNewWorktreeProject(null); }}
                project={newWorktreeProject}
                onWorktreeCreated={handleCustomWorktreeCreated}
            />
        ) : null}
        </>
    );
}
