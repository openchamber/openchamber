import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerReviewFlow } from './useComposerReviewFlow';
import type { useComposerReferencePickerState } from './useComposerReferencePickerState';
import type { useComposerReferencePicker } from './useComposerReferencePicker';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerReferenceActions } from './useComposerReferenceActions';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerMobilePanels } from './useComposerMobilePanels';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerFilePicker } from './useComposerFilePicker';
import type { useComposerDraftTarget } from './useComposerDraftTarget';
import type { useComposerAttachmentPreview } from './useComposerAttachmentPreview';
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
import { AttachmentPickerInput } from './ComposerAttachmentPickerInput';
import { GuestAttachDialog, ToolOutputDialog } from './ComposerLazyDialogs';

type Dependencies = {
    referencePickerState: Pick<ReturnType<typeof useComposerReferencePickerState>, 'referencePicker' | 'setReferencePicker'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileShell'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'referencePickerDirectory' | 'referenceScope' | 'linkedReferences' | 'openSharedPageKey' | 'setOpenSharedPageKey'>;
    referencePicker: Pick<ReturnType<typeof useComposerReferencePicker>, 'attachReferences' | 'repositoryDescriptor' | 'openGitHubPicker'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'attachDialogGuestId' | 'attachDialogItem' | 'setAttachDialogGuestId' | 'setAttachDialogItem' | 'updateLinkedReferences'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'reviewDialogMounted' | 'reviewDialogOpen' | 'setReviewDialogOpen' | 'currentSessionDirectoryForSync' | 'currentDirectory'>;
    reviewFlow: Pick<ReturnType<typeof useComposerReviewFlow>, 'reviewFlowSubmitting' | 'handleStartReviewFlow'>;
    attachmentPreview: Pick<ReturnType<typeof useComposerAttachmentPreview>, 'attachmentPreviewMounted' | 'attachmentPreview' | 'handleAttachmentPreviewOpenChange'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile' | 'currentTheme'>;
    referenceActions: Pick<ReturnType<typeof useComposerReferenceActions>, 'openSharedPage' | 'trackerPickers' | 'guestAttachItems' | 'openGuestAttach'>;
    filePicker: Pick<ReturnType<typeof useComposerFilePicker>, 'fileInputRef' | 'handleLocalFileSelect' | 'handlePickLocalFiles'>;
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'mobileAttachMenuOpen' | 'setMobileAttachMenuOpen' | 'mobileDraftPicker'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    draftTarget: Pick<ReturnType<typeof useComposerDraftTarget>, 'showDraftTargetSelectors' | 'selectedDraftProject' | 'draftProjects' | 'selectedDraftDirectory' | 'selectedDraftBranchLabel' | 'selectedDraftBranchIsKnown' | 'selectedDraftDirectoryHasUncommittedChanges' | 'projectRootBranchOption' | 'worktreeBranchOptions' | 'spaceBranchOptions' | 'draftBranchItems' | 'shouldShowDraftBranchSelector' | 'handleDraftProjectChange' | 'handleDraftDirectoryChange' | 'handleCreateSpace' | 'handleCreateCustomWorktree' | 'handleMobileDraftPickerChange' | 'newSpaceProject' | 'setNewSpaceProject' | 'newWorktreeProject' | 'setNewWorktreeProject' | 'handleCustomWorktreeCreated'>;
};

export function renderComposerDialogs({
    referencePickerState, mobileShell: mobile, language, referencePicker: pickerActions,
    referenceDrafts, sessionScope, reviewFlow, attachmentPreview: preview, preferences,
    referenceActions, filePicker, mobilePanels, i18n, draftTarget,
}: Dependencies) {
    const { referencePicker, setReferencePicker } = referencePickerState;
    const { mobileShell } = mobile;
    const { referencePickerDirectory, referenceScope, linkedReferences, openSharedPageKey, setOpenSharedPageKey } = language;
    const { attachReferences, repositoryDescriptor, openGitHubPicker } = pickerActions;
    const {
        attachDialogGuestId, attachDialogItem, setAttachDialogGuestId, setAttachDialogItem,
        updateLinkedReferences,
    } = referenceDrafts;
    const {
        reviewDialogMounted, reviewDialogOpen, setReviewDialogOpen, currentSessionDirectoryForSync,
        currentDirectory,
    } = sessionScope;
    const { reviewFlowSubmitting, handleStartReviewFlow } = reviewFlow;
    const { attachmentPreviewMounted, attachmentPreview, handleAttachmentPreviewOpenChange } = preview;
    const { isMobile, currentTheme } = preferences;
    const { openSharedPage, trackerPickers, guestAttachItems, openGuestAttach } = referenceActions;
    const { fileInputRef, handleLocalFileSelect, handlePickLocalFiles } = filePicker;
    const { mobileAttachMenuOpen, setMobileAttachMenuOpen, mobileDraftPicker } = mobilePanels;
    const { t } = i18n;
    const {
        showDraftTargetSelectors, selectedDraftProject, draftProjects, selectedDraftDirectory,
        selectedDraftBranchLabel, selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges, projectRootBranchOption, worktreeBranchOptions,
        spaceBranchOptions, draftBranchItems, shouldShowDraftBranchSelector, handleDraftProjectChange,
        handleDraftDirectoryChange, handleCreateSpace, handleCreateCustomWorktree,
        handleMobileDraftPickerChange, newSpaceProject, setNewSpaceProject, newWorktreeProject,
        setNewWorktreeProject, handleCustomWorktreeCreated,
    } = draftTarget;

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
                directories={referenceScope.directories}
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

        <AttachmentPickerInput ref={fileInputRef} onChange={handleLocalFileSelect} />

        {isMobile ? (
            <MobileOverlayPanel
                open={mobileAttachMenuOpen}
                title={t('chat.chatInput.actions.addAttachment')}
                onClose={() => setMobileAttachMenuOpen(false)}
            >
                <MobileSheetRow
                    icon="attachment-2"
                    onClick={() => {
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
