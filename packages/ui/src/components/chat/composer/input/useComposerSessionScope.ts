import type { useComposerDraftText } from './useComposerDraftText';
import { stopCurrentOperation } from '@/sync/prompt-take-back';
import type { useComposerColumn } from './useComposerColumn';
import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useDraftAttachedFiles, useInputStore } from '@/sync/input-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createChatDraftIdentity, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { btwHoldsDock, useBtwPanelState } from '../../btw/useBtwPanelState';
import { btwPendingComposerKey } from '@/lib/btw';
import { useProjectActions } from '@/components/layout/projectActionsRunnerContext';
import { usePendingComposerReferences } from '../../composer/pendingComposerReferences';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useRetryModelPick } from '@/hooks/useRetryModelPick';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useComposerTextEffect } from '../../composer/state/composerText';
import { useOpenCodeTrustPaused } from '@/components/projects/useOpenCodeTrustPause';
import { useFolderMissing } from '@/components/session/sidebar/projects/useProjectFolderMissing';
import type { SpaceTarget } from '@/lib/spaces/space-model-offer';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useMessageSelecting } from '@/stores/useMessageSelectionStore';
import { useScopedBlockingForms, useScopedBlockingPermissions } from '@/sync/sync-context';
import { resolveWorkDraftComposerKey, NEW_CHAT_DRAFT_DIRECTORY } from './composerDraftIdentity';

const probeSessionLocation = (directory: string) => opencodeClient.getLocationAvailability(directory);

type Dependencies = {
    column: Pick<ReturnType<typeof useComposerColumn>, 'chatColumnSession' | 'columnPinned'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'inputModeParentRef' | 'setInputMode' | 'storedInputMode' | 'composerText'>;
};

export function useComposerSessionScope({
    column, draftText,
}: Dependencies) {
    const { chatColumnSession, columnPinned } = column;
    const { inputModeParentRef, setInputMode, storedInputMode, composerText } = draftText;

    const liveSessionId = useSessionUIStore((s) => (chatColumnSession ? null : s.currentSessionId));

    const currentSessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;

    const messageSelectionActive = useMessageSelecting(currentSessionId);

    React.useEffect(() => {
        if (inputModeParentRef.current !== null && inputModeParentRef.current !== currentSessionId) {
            setInputMode('normal');
        }
        inputModeParentRef.current = currentSessionId;
    }, [currentSessionId, inputModeParentRef, setInputMode]);

    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);

    const liveEffectiveDirectory = useEffectiveDirectory();

    const currentDirectory = liveEffectiveDirectory ?? fallbackDirectory;

    const currentSessionDirectoryForSync = useSessionUIStore(
        React.useCallback((s) => currentSessionId ? s.getDirectoryForSession(currentSessionId) : null, [currentSessionId]),
    );

    const trustDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;

    const trustPausedDirectory = useOpenCodeTrustPaused(trustDirectory) ? trustDirectory : null;

    const btwPanel = useBtwPanelState(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);

    const pendingForms = useScopedBlockingForms(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);

    const pendingPermissions = useScopedBlockingPermissions(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);

    const hasPendingPermission = pendingPermissions.length > 0;

    const hasPendingForm = pendingForms.length > 0 || hasPendingPermission;

    const btwSessionId = btwPanel.btwSessionId;

    const btwDirectory = btwPanel.btwDirectory;

    const btwComposerSessionId = btwPanel.pending && currentSessionId
        ? btwPendingComposerKey(currentSessionId)
        : btwSessionId;

    const isBtwActive = Boolean(btwComposerSessionId) && !btwPanel.collapsed;

    useRetryModelPick(
        isBtwActive ? btwSessionId : currentSessionId,
        (isBtwActive ? btwDirectory : null) ?? currentSessionDirectoryForSync ?? currentDirectory ?? undefined,
    );

    const isBtwPanelVisible = btwHoldsDock(btwPanel, hasPendingForm);

    const immediateBtwSubmitRef = React.useRef<{ identity: ChatDraftIdentity; text: string } | null>(null);

    const draftCaretModeRef = React.useRef({ btw: isBtwActive, atEnd: isBtwActive });

    const inputMode = isBtwActive ? 'normal' : storedInputMode;

    const isPromotedBtwSession = btwPanel.parentPromoted;

    const activeRuntimeKey = getRuntimeKey();

    const isNewChatDraft = useSessionUIStore((s) => (
        !columnPinned && !currentSessionId && Boolean(s.newSessionDraft?.open) && s.newSessionDraft.target === 'chat'
    ));

    const workDraftKey = useSessionUIStore((s) => (columnPinned || currentSessionId ? null : resolveWorkDraftComposerKey(s.newSessionDraft)));

    const chatDraftIdentity = React.useMemo(
        () => createChatDraftIdentity(
            activeRuntimeKey,
            isNewChatDraft ? NEW_CHAT_DRAFT_DIRECTORY : currentSessionDirectoryForSync ?? currentDirectory,
            isBtwActive ? btwComposerSessionId : currentSessionId ?? workDraftKey,
        ),
        [activeRuntimeKey, btwComposerSessionId, currentDirectory, currentSessionDirectoryForSync, currentSessionId, isBtwActive, isNewChatDraft, workDraftKey],
    );

    const claimAttachmentSlot = React.useCallback(() => {
        useInputStore.getState().selectAttachmentDraft(chatDraftIdentity);
    }, [chatDraftIdentity]);

    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);

    const newSessionDraftOpen = !columnPinned && Boolean(newSessionDraft?.open);

    const spaceTarget = React.useMemo<SpaceTarget | null>(() => {
        if (currentSessionId) return { requestId: null, directory: currentSessionDirectoryForSync ?? currentDirectory ?? null };
        if (!newSessionDraftOpen) return null;
        return { requestId: newSessionDraft?.pendingWorktreeRequestId ?? null, directory: newSessionDraft?.directoryOverride ?? null };
    }, [currentDirectory, currentSessionDirectoryForSync, currentSessionId, newSessionDraft?.directoryOverride, newSessionDraft?.pendingWorktreeRequestId, newSessionDraftOpen]);

    const sessionFolder = useFolderMissing(
        !newSessionDraftOpen && !isSpaceDirectory(currentSessionDirectoryForSync) ? currentSessionDirectoryForSync ?? undefined : undefined,
        probeSessionLocation,
    );

    const sendHeldByMissingFolder = () => {
        if (!sessionFolder.missing || isBtwActive) return false;
        if (!sessionFolder.confirmed) {
            sessionFolder.clearSendMark();
            return false;
        }
        sessionFolder.recheck();
        return true;
    };

    const sendHeldByMissingFolderRef = React.useRef(sendHeldByMissingFolder);

    sendHeldByMissingFolderRef.current = sendHeldByMissingFolder;

    const draftPermissionMode = useSessionUIStore((s) => (
        s.newSessionDraft?.open ? s.newSessionDraft.permissionMode : undefined
    ));

    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);

    const setDraftPermissionMode = useSessionUIStore((s) => s.setDraftPermissionMode);

    const prepareChatDraftDirectory = useSessionUIStore((s) => s.prepareChatDraftDirectory);

    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);

    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);

    const attachedFiles = useDraftAttachedFiles(chatDraftIdentity);

    const addAttachedFile = useInputStore((s) => s.addAttachedFile);

    const clearAttachedFiles = useInputStore((s) => s.clearAttachedFiles);

    const pickSessionAgent = useSelectionStore((s) => s.pickSessionAgent);

    const sessionAgentPick = useSelectionStore(React.useCallback(
        (s) => currentSessionId ? s.sessionPickedAgents.get(currentSessionId) ?? null : null,
        [currentSessionId],
    ));

    const btwModelSelection = useSelectionStore(React.useCallback(
        (s) => btwComposerSessionId ? s.sessionModelSelections.get(btwComposerSessionId) ?? null : null,
        [btwComposerSessionId],
    ));

    const btwAgentSelection = useSelectionStore(React.useCallback(
        (s) => btwComposerSessionId ? s.sessionAgentSelections.get(btwComposerSessionId) ?? null : null,
        [btwComposerSessionId],
    ));

    const consumePendingBtwComposerRequest = useInputStore((s) => s.consumePendingBtwComposerRequest);

    const pendingBtwComposerRequest = useInputStore((s) => s.pendingBtwComposerRequest);

    const pendingPresetSubmit = useInputStore((s) => s.pendingPresetSubmit);

    const pendingDraftSubmit = useInputStore((s) => s.pendingDraftSubmit);

    const setPendingInputText = useInputStore((s) => s.setPendingInputText);

    const pendingGuestIssue = useInputStore((s) => s.pendingGuestIssue);

    const consumePendingGuestIssue = useInputStore((s) => s.consumePendingGuestIssue);

    const pendingComposerReferenceCount = usePendingComposerReferences((s) => s.pending.length);

    useComposerTextEffect(composerText, (message) => {
        if (!newSessionDraftOpen || newSessionDraft.target !== 'chat' || message.trim().length === 0) return;
        void prepareChatDraftDirectory();
    }, [newSessionDraft.target, newSessionDraftOpen, prepareChatDraftDirectory]);

    const consumePendingSyntheticParts = useInputStore((s) => s.consumePendingSyntheticParts);

    const projectActions = useProjectActions();

    const projectActionsRef = React.useRef(projectActions);

    projectActionsRef.current = projectActions;

    const acknowledgeSessionAbort = useSessionUIStore((s) => s.acknowledgeSessionAbort);

    const abortCurrentOperation = React.useCallback(
        (sessionIdOverride?: string) => stopCurrentOperation(sessionIdOverride ?? currentSessionId ?? ''),
        [currentSessionId],
    );

    const currentManagementSessionId = currentSessionId;

    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);

    const [reviewDialogMounted, setReviewDialogMounted] = React.useState(false);

    if (reviewDialogOpen && !reviewDialogMounted) setReviewDialogMounted(true);

    const closeReviewDialog = React.useCallback(() => setReviewDialogOpen(false), []);

    return {
        spaceTarget,
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
    };
}
