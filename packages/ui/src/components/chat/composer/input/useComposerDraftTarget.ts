import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { abortShortcutReachesComposer, isTouchOnlyInput } from '../../composer/state/abortShortcutReach';
import { cn } from '@/lib/utils';
import { useChatSurfaceMode } from '../../useChatSurfaceMode';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useDraftHeading } from '../../useDraftHeading';
import { useDraftTarget } from '../../composer/state/useDraftTarget';
import { isSpaceCreationRequest } from '@/lib/spaces/space-creation-requests';
import { isDraftSendWaiting, subscribeDraftSendWaiting } from '@/lib/worktrees/pendingDraftWorktree';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerReferenceActions } from './useComposerReferenceActions';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { ChatInputProps } from './chatInputProps';

type Dependencies = Pick<ReturnType<typeof useComposerSessionScope>, 'newSessionDraftOpen' | 'newSessionDraft' | 'isBtwActive' | 'setNewSessionDraftTarget'>
    & Pick<ReturnType<typeof useComposerReferenceActions>, 'isVSCode'>
    & Pick<ReturnType<typeof useComposerInputState>, 'setMobileDraftPicker'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile' | 'isDesktopExpanded'>
    & Pick<ChatInputProps, 'draftPresentationExiting'>;

export function useComposerDraftTarget({
    newSessionDraftOpen, isVSCode, setMobileDraftPicker, newSessionDraft, isBtwActive, isMobile,
    draftPresentationExiting, isDesktopExpanded, setNewSessionDraftTarget,
}: Dependencies) {
    const showDraftTargetSelectors = newSessionDraftOpen && !isVSCode;

    // Which project and directory a new session will target.
    const {
        projects: draftProjects,
        selectedDraftProject,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges,
        projectRootBranchOption,
        worktreeBranchOptions,
        spaceBranchOptions,
        draftBranchItems,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftDirectoryChange,
        refreshDraftTarget,
    } = useDraftTarget(showDraftTargetSelectors);

    const draftHeading = useDraftHeading(draftProjectLabel);

    const handleMobileDraftPickerChange = React.useCallback((picker: 'project' | 'branch' | null) => {
        if (picker === 'branch') {
            refreshDraftTarget();
        }
        setMobileDraftPicker(picker);
    }, [refreshDraftTarget, setMobileDraftPicker]);

    // The one entry to an isolated space: while the feature's switch is on, for a project the
    // branch selector serves, never in VS Code (decision 16). The dialog keeps the project it
    // was opened for, whatever the draft picks after.
    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);

    const [newSpaceProject, setNewSpaceProject] = React.useState<{ id: string; path: string } | null>(null);

    const draftRequestId = newSessionDraft?.pendingWorktreeRequestId ?? null;

    const messageWaitsForSpace = React.useSyncExternalStore(
        subscribeDraftSendWaiting,
        () => isDraftSendWaiting(draftRequestId) && isSpaceCreationRequest(draftRequestId),
    );

    const handleCreateSpace = React.useMemo(() => {
        if (!isolatedSpacesEnabled || isVSCode || !selectedDraftProject || selectedDraftProject.kind === 'chat') return undefined;
        const project = { id: selectedDraftProject.id, path: selectedDraftProject.path };
        return () => setNewSpaceProject(project);
    }, [isVSCode, isolatedSpacesEnabled, selectedDraftProject]);

    // The full New Worktree dialog for the draft's project, so a named worktree, an existing
    // branch or a PR branch can be made where the sidebar has no project headers (Timeline).
    const [newWorktreeProject, setNewWorktreeProject] = React.useState<{ id: string; path: string } | null>(null);

    const handleCreateCustomWorktree = React.useMemo(() => {
        if (!selectedDraftProject || selectedDraftProject.kind === 'chat') return undefined;
        const project = { id: selectedDraftProject.id, path: selectedDraftProject.path };
        return () => setNewWorktreeProject(project);
    }, [selectedDraftProject]);

    const handleCustomWorktreeCreated = React.useCallback((worktreePath: string) => {
        const project = newWorktreeProject;
        if (!project) return;
        // Pin the draft to the new directory: until the worktree list refreshes,
        // the draft's validity check would otherwise reset it to the project root.
        const sessionStore = useSessionUIStore.getState();
        if (sessionStore.newSessionDraft.open) {
            sessionStore.overrideNewSessionDraftTarget({
                projectId: project.id,
                directoryOverride: worktreePath,
                pendingWorktreeRequestId: null,
                bootstrapPendingDirectory: worktreePath,
                preserveDirectoryOverride: true,
            });
        } else {
            sessionStore.openNewSessionDraft({
                selectedProjectId: project.id,
                directoryOverride: worktreePath,
                bootstrapPendingDirectory: worktreePath,
                preserveDirectoryOverride: true,
            });
        }
        useDirectoryStore.getState().setDirectory(worktreePath, { showOverlay: false });
    }, [newWorktreeProject]);

    const chatSurfaceMode = useChatSurfaceMode();

    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';

    // Whether double Escape can stop this composer's run; where it cannot,
    // the action button keeps a visible Stop beside Send (abortShortcutReach).
    const abortShortcutReaches = abortShortcutReachesComposer({
        surface: isBtwActive ? 'btw' : isMiniChatSurface ? 'mini-chat' : chatSurfaceMode === 'default' ? 'main' : 'unknown',
        touch: isMobile || isTouchOnlyInput(),
    });

    const showDesktopDraftPresentation = (newSessionDraftOpen || draftPresentationExiting)
        && !isDesktopExpanded
        && !isMobile
        && !isVSCode
        && !isMiniChatSurface;

    const draftPresentationClassName = cn(
        'transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
        draftPresentationExiting && 'pointer-events-none opacity-0',
    );

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProject || selectedDraftProject.kind === 'chat' || !selectedDraftDirectory) {
            return;
        }
        if (newSessionDraft?.pendingWorktreeRequestId || newSessionDraft?.bootstrapPendingDirectory || newSessionDraft?.preserveDirectoryOverride) {
            return;
        }
        const valid = draftBranchItems.some((option) => option.value === selectedDraftDirectory);
        if (valid) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: selectedDraftProject.path,
        });
    }, [draftBranchItems, newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, selectedDraftDirectory, selectedDraftProject, setNewSessionDraftTarget, showDraftTargetSelectors]);

    return {
        showDraftTargetSelectors, messageWaitsForSpace, showDesktopDraftPresentation,
        draftPresentationClassName, draftHeading, draftProjectLabel, selectedDraftProject, draftProjects,
        selectedDraftDirectory, selectedDraftBranchLabel, selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges, projectRootBranchOption, worktreeBranchOptions,
        spaceBranchOptions, draftBranchItems, shouldShowDraftBranchSelector, handleDraftProjectChange,
        handleDraftDirectoryChange, refreshDraftTarget, handleCreateSpace, handleCreateCustomWorktree,
        handleMobileDraftPickerChange, abortShortcutReaches, newSpaceProject, setNewSpaceProject,
        newWorktreeProject, setNewWorktreeProject, handleCustomWorktreeCreated,
    };
}
