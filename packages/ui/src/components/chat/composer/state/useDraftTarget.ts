
import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { formatDirectoryName } from '@/lib/utils';
import { useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { buildSessionTargetOptions } from '@/sync/session-worktree-contract';
import {
    listProjectWorktrees,
    partitionWorktreesByRegisteredProject,
    preserveClientTrackedWorktreeStatus,
    replaceRepositoryWorktrees,
    worktreeMapsEqual,
} from '@/lib/worktrees/worktreeManager';
import { normalizePath } from '../attachments/filePaths';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';
import { getGitStatus } from '@/lib/gitApi';
import { draftSpaceTarget, isSpaceCreationRequest, spaceOfCreationRequest } from '@/lib/spaces/space-creation-requests';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useComposerFollowsSpace } from '@/lib/spaces/useComposerFollowsSpace';
import { spacesOfProject, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';

const BRANCHES_SWR_TTL_MS = 30_000;
const DRAFT_TARGET_REFRESH_THROTTLE_MS = 2_000;

export interface DraftTargetProject {
    id: string;
    path: string;
    label?: string;
    icon?: string | null;
    color?: string | null;
    iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
    iconBackground?: string | null;
    kind?: 'chat' | 'project';
}

function releaseDraftDirectoryPin() {
    const store = useSessionUIStore.getState();
    if (store.newSessionDraft?.preserveDirectoryOverride) {
        store.setDraftPreserveDirectoryOverride(false);
    }
}

export function getProjectDisplayLabel(project: { label?: string; path: string }): string {
    return project.label?.trim() || formatDirectoryName(project.path);
}

export function useDraftTarget(enabled: boolean) {
    const configuredProjects: readonly DraftTargetProject[] = useProjectsStore((state) => state.projects);
    const { t } = useI18n();
    const spacesJourney = useSpacesStore((state) => state.journey);
    const chatProject = React.useMemo<DraftTargetProject>(() => ({
        id: CHAT_DRAFT_PROJECT_ID,
        path: '',
        label: t('layout.mainTab.chat'),
        kind: 'chat',
    }), [t]);
    const projects = React.useMemo(() => [chatProject, ...configuredProjects], [chatProject, configuredProjects]);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const availableWorktreesByProject = useSessionUIStore((s) => s.availableWorktreesByProject);
    const fetchGitStatus = useGitStore((state) => state.fetchStatus);
    const { git: runtimeGit } = useRuntimeAPIs();

    const selectedDraftProject = React.useMemo(() => {
        if (newSessionDraft?.target === 'chat') return chatProject;
        const explicit = newSessionDraft?.selectedProjectId
            ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
            : null;
        if (explicit) {
            return explicit;
        }

        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        if (active) {
            return active;
        }

        return configuredProjects[0] ?? chatProject;
    }, [activeProjectId, chatProject, configuredProjects, newSessionDraft?.selectedProjectId, newSessionDraft?.target, projects]);

    const selectedDraftProjectPath = React.useMemo(
        () => selectedDraftProject?.kind === 'chat' ? null : normalizePath(selectedDraftProject?.path ?? null),
        [selectedDraftProject?.kind, selectedDraftProject?.path],
    );
    const draftProjectLabel = selectedDraftProject && selectedDraftProject.kind !== 'chat'
        ? getProjectDisplayLabel(selectedDraftProject)
        : null;

    const selectedDraftProjectBranches = useGitBranches(selectedDraftProjectPath);
    const selectedDraftProjectBranchesFetchedAt = useGitStore(
        (s) => (selectedDraftProjectPath ? s.directories.get(selectedDraftProjectPath)?.lastBranchesFetch ?? 0 : 0),
    );
    const selectedDraftProjectIsGitRepo = useIsGitRepo(selectedDraftProjectPath);
    const hasDraftBranchList = Boolean(selectedDraftProjectBranches?.all);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const [isDiscoveringDraftBranches, setIsDiscoveringDraftBranches] = React.useState(false);
    const [dirtyDraftDirectory, setDirtyDraftDirectory] = React.useState<string | null>(null);
    const lastDraftTargetRefreshRef = React.useRef(0);

    const refreshDraftWorktrees = React.useCallback(async (project: DraftTargetProject) => {
        if (project.kind === 'chat') {
            return;
        }

        try {
            const worktrees = await listProjectWorktrees({ id: project.id, path: project.path }, { force: true });
            const draft = useSessionUIStore.getState().newSessionDraft;
            if (draft.pendingWorktreeRequestId || draft.bootstrapPendingDirectory) {
                return;
            }
            const published = useSessionUIStore.getState().availableWorktreesByProject;
            const replaced = replaceRepositoryWorktrees(published, project.path, worktrees);
            const partitioned = partitionWorktreesByRegisteredProject(useProjectsStore.getState().projects, replaced);
            const next = preserveClientTrackedWorktreeStatus(partitioned, published);
            if (worktreeMapsEqual(next, published)) {
                return;
            }
            useSessionUIStore.setState({
                availableWorktrees: [...next.values()].flat(),
                availableWorktreesByProject: next,
            });
        } catch {
            // Keep the last known list; the next focus or picker open retries.
        }
    }, []);

    const refreshDraftTarget = React.useCallback(() => {
        if (
            !enabled
            || !selectedDraftProject
            || selectedDraftProject.kind === 'chat'
            || !selectedDraftProjectPath
            || !runtimeGit
            || selectedDraftProjectIsGitRepo !== true
            || newSessionDraft?.pendingWorktreeRequestId
            || newSessionDraft?.bootstrapPendingDirectory
            || useGitStore.getState().isAskingRemotes(selectedDraftProjectPath)
        ) {
            return;
        }

        const now = Date.now();
        if (now - lastDraftTargetRefreshRef.current < DRAFT_TARGET_REFRESH_THROTTLE_MS) {
            return;
        }
        lastDraftTargetRefreshRef.current = now;

        void fetchBranches(selectedDraftProjectPath, runtimeGit);
        void refreshDraftWorktrees(selectedDraftProject);
    }, [
        enabled,
        fetchBranches,
        newSessionDraft?.bootstrapPendingDirectory,
        newSessionDraft?.pendingWorktreeRequestId,
        refreshDraftWorktrees,
        runtimeGit,
        selectedDraftProject,
        selectedDraftProjectIsGitRepo,
        selectedDraftProjectPath,
    ]);

    React.useEffect(() => {
        lastDraftTargetRefreshRef.current = 0;
    }, [selectedDraftProjectPath]);

    React.useEffect(() => {
        if (!enabled) {
            return;
        }

        const refreshWhenVisible = () => {
            if (document.visibilityState === 'hidden') {
                return;
            }
            refreshDraftTarget();
        };
        window.addEventListener('focus', refreshWhenVisible);
        document.addEventListener('visibilitychange', refreshWhenVisible);
        return () => {
            window.removeEventListener('focus', refreshWhenVisible);
            document.removeEventListener('visibilitychange', refreshWhenVisible);
        };
    }, [enabled, refreshDraftTarget]);

    React.useEffect(() => {
        if (!enabled || !selectedDraftProjectPath || !runtimeGit || selectedDraftProjectIsGitRepo !== null) {
            return;
        }

        void fetchGitStatus(selectedDraftProjectPath, runtimeGit, { silent: true });
    }, [fetchGitStatus, runtimeGit, selectedDraftProjectIsGitRepo, selectedDraftProjectPath, enabled]);

    React.useEffect(() => {
        if (!enabled || !selectedDraftProjectPath || !selectedDraftProject || !runtimeGit || selectedDraftProjectIsGitRepo !== true) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        const isStale =
            !selectedDraftProjectBranchesFetchedAt ||
            Date.now() - selectedDraftProjectBranchesFetchedAt > BRANCHES_SWR_TTL_MS;

        if (hasDraftBranchList && !isStale) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        let cancelled = false;
        setIsDiscoveringDraftBranches(!hasDraftBranchList);

        void fetchBranches(selectedDraftProjectPath, runtimeGit)
            .finally(() => {
                if (!cancelled) {
                    setIsDiscoveringDraftBranches(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [fetchBranches, runtimeGit, selectedDraftProject, selectedDraftProjectBranchesFetchedAt, hasDraftBranchList, selectedDraftProjectIsGitRepo, selectedDraftProjectPath, enabled]);

    const selectedDraftProjectCurrentBranch = selectedDraftProjectBranches?.current?.trim() ?? '';

    const projectRootBranchOption = React.useMemo(() => {
        if (!selectedDraftProject) {
            return null;
        }
        const value = normalizePath(selectedDraftProject.path);
        if (!value) {
            return null;
        }
        if (!selectedDraftProjectCurrentBranch) {
            return null;
        }
        return {
            value,
            label: selectedDraftProjectCurrentBranch,
        };
    }, [selectedDraftProject, selectedDraftProjectCurrentBranch]);

    const worktreeBranchOptions = React.useMemo(() => {
        if (!selectedDraftProject) {
            return [];
        }

        const worktrees = (() => {
            if (!selectedDraftProjectPath) {
                return [];
            }
            return availableWorktreesByProject.get(selectedDraftProjectPath)
                ?? availableWorktreesByProject.get(selectedDraftProject.path)
                ?? [];
        })();

        return buildSessionTargetOptions({
            projectRoot: normalizePath(selectedDraftProject.path) ?? '',
            rootBranch: selectedDraftProjectCurrentBranch,
            worktrees,
            pendingBootstrapDirectory: newSessionDraft?.bootstrapPendingDirectory ?? null,
        }).filter((option) => option.kind === 'worktree');
    }, [availableWorktreesByProject, newSessionDraft?.bootstrapPendingDirectory, selectedDraftProject, selectedDraftProjectCurrentBranch, selectedDraftProjectPath]);

    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
    const spaceBranchOptions = React.useMemo(() => {
        if (!isolatedSpacesEnabled || !spacesJourney || !selectedDraftProjectPath) return [];
        return spacesOfProject(spacesJourney, selectedDraftProjectPath).flatMap((entry) => {
            const value = normalizePath(entry.directory);
            if (!value || (entry.state !== 'running' && entry.state !== 'exited')) return [];
            return [{ value, label: entry.name || t('sessions.sidebar.grouping.spaceUnnamed') }];
        });
    }, [isolatedSpacesEnabled, selectedDraftProjectPath, spacesJourney, t]);

    const draftSpace = draftSpaceTarget(newSessionDraft?.pendingWorktreeRequestId, spacesJourney);
    const draftSpaceDirectory = draftSpace?.kind === 'ready' ? normalizePath(draftSpace.directory) : null;
    const selectedDraftDirectory = React.useMemo(
        () => draftSpaceDirectory
            ?? normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null)
            ?? normalizePath(newSessionDraft?.directoryOverride ?? null)
            ?? selectedDraftProjectPath,
        [draftSpaceDirectory, newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.directoryOverride, selectedDraftProjectPath],
    );
    useComposerFollowsSpace(enabled && isSpaceDirectory(selectedDraftDirectory) ? selectedDraftDirectory : null);

    const selectedDraftDirectoryBootstrapPending = useWorktreeBootstrapPending(selectedDraftDirectory);
    const draftDirectoryNeedsFreshStatusRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (
            !enabled
            || !selectedDraftDirectory
            || selectedDraftProject?.kind === 'chat'
            || isSpaceDirectory(selectedDraftDirectory)
            || newSessionDraft?.pendingWorktreeRequestId
            || newSessionDraft?.bootstrapPendingDirectory
            || selectedDraftDirectoryBootstrapPending
        ) {
            if (selectedDraftDirectoryBootstrapPending && selectedDraftDirectory) {
                draftDirectoryNeedsFreshStatusRef.current = selectedDraftDirectory;
            }
            setDirtyDraftDirectory(null);
            return;
        }

        let cancelled = false;
        setDirtyDraftDirectory(null);
        const needsFreshStatus = draftDirectoryNeedsFreshStatusRef.current === selectedDraftDirectory;
        const statusRequest = needsFreshStatus
            ? getGitStatus(selectedDraftDirectory, { mode: 'light', fresh: true })
            : getGitStatus(selectedDraftDirectory, { mode: 'light' });
        statusRequest
            .then((status) => {
                if (!cancelled && needsFreshStatus && draftDirectoryNeedsFreshStatusRef.current === selectedDraftDirectory) {
                    draftDirectoryNeedsFreshStatusRef.current = null;
                }
                if (!cancelled && (status.files?.length ?? 0) > 0) {
                    setDirtyDraftDirectory(selectedDraftDirectory);
                }
            })
            .catch(() => {
                if (!cancelled) setDirtyDraftDirectory(null);
            });

        return () => {
            cancelled = true;
        };
    }, [enabled, newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, selectedDraftDirectory, selectedDraftDirectoryBootstrapPending, selectedDraftProject?.kind]);

    const shouldKeepMissingSelectedDraftDirectory = React.useMemo(() => {
        const pendingDirectory = normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null);
        return Boolean(
            newSessionDraft?.preserveDirectoryOverride
            ||
            newSessionDraft?.pendingWorktreeRequestId
            || selectedDraftDirectoryBootstrapPending
            || (pendingDirectory && pendingDirectory === selectedDraftDirectory)
        );
    }, [newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, selectedDraftDirectory, selectedDraftDirectoryBootstrapPending]);

    const draftBranchItems = React.useMemo(() => {
        const baseItems: Array<{ value: string; label: string }> = [];
        if (projectRootBranchOption) {
            baseItems.push(projectRootBranchOption);
        }
        baseItems.push(...worktreeBranchOptions, ...spaceBranchOptions);

        if (!selectedDraftDirectory) {
            return baseItems;
        }
        if (baseItems.some((option) => option.value === selectedDraftDirectory)) {
            return baseItems;
        }
        if (!shouldKeepMissingSelectedDraftDirectory) {
            return baseItems;
        }
        return [
            ...baseItems,
            { value: selectedDraftDirectory, label: formatDirectoryName(selectedDraftDirectory) },
        ];
    }, [projectRootBranchOption, selectedDraftDirectory, shouldKeepMissingSelectedDraftDirectory, spaceBranchOptions, worktreeBranchOptions]);

    const selectedDraftBranchLabel = React.useMemo(() => {
        if (newSessionDraft?.pendingWorktreeRequestId) {
            if (!isSpaceCreationRequest(newSessionDraft.pendingWorktreeRequestId)) return t('session.newWorktree.actions.creating');
            const space = spaceOfCreationRequest(newSessionDraft.pendingWorktreeRequestId);
            const entry = space ? spacesJourney?.get(space) : undefined;
            return entry && entry.state === 'running' ? entry.name : t('spaces.draft.preparing');
        }
        const selectedValue = selectedDraftDirectory ?? draftBranchItems[0]?.value ?? null;
        if (!selectedValue) {
            return null;
        }
        return draftBranchItems.find((item) => item.value === selectedValue)?.label ?? formatDirectoryName(selectedValue);
    }, [draftBranchItems, newSessionDraft?.pendingWorktreeRequestId, selectedDraftDirectory, spacesJourney, t]);


    const selectedDraftBranchIsKnown = React.useMemo(() => {
        if (!selectedDraftDirectory) {
            return true;
        }
        if (projectRootBranchOption?.value === selectedDraftDirectory) {
            return true;
        }
        return [...worktreeBranchOptions, ...spaceBranchOptions].some((option) => option.value === selectedDraftDirectory);
    }, [projectRootBranchOption?.value, selectedDraftDirectory, spaceBranchOptions, worktreeBranchOptions]);

    React.useEffect(() => {
        if (!newSessionDraft?.open || !newSessionDraft?.preserveDirectoryOverride) {
            return;
        }
        if (!selectedDraftDirectory || !selectedDraftBranchIsKnown || isSpaceDirectory(selectedDraftDirectory)) {
            return;
        }
        useSessionUIStore.getState().setDraftPreserveDirectoryOverride(false);
    }, [newSessionDraft?.open, newSessionDraft?.preserveDirectoryOverride, selectedDraftBranchIsKnown, selectedDraftDirectory]);

    const shouldShowDraftBranchSelector = React.useMemo(() => {
        if (selectedDraftProjectIsGitRepo !== true) {
            return false;
        }
        if (isDiscoveringDraftBranches) {
            return false;
        }
        if (projectRootBranchOption) {
            return true;
        }
        return worktreeBranchOptions.length > 0;
    }, [isDiscoveringDraftBranches, projectRootBranchOption, selectedDraftProjectIsGitRepo, worktreeBranchOptions.length]);

    const handleDraftProjectChange = React.useCallback((projectId: string) => {
        const draft = useSessionUIStore.getState().newSessionDraft;
        if (draft?.pendingWorktreeRequestId || draft?.bootstrapPendingDirectory) {
            return;
        }
        const project = projects.find((entry) => entry.id === projectId);
        if (!project) {
            return;
        }
        if (draft?.preserveDirectoryOverride && projectId === selectedDraftProject?.id) {
            return;
        }
        releaseDraftDirectoryPin();
        if (project.kind === 'chat') {
            setNewSessionDraftTarget({ projectId: CHAT_DRAFT_PROJECT_ID, directoryOverride: null }, { force: true });
            return;
        }
        if (activeProjectId !== projectId) {
            setActiveProjectIdOnly(projectId);
        }
        setNewSessionDraftTarget({
            projectId,
            directoryOverride: project.path,
        }, { force: true });
    }, [activeProjectId, projects, selectedDraftProject?.id, setActiveProjectIdOnly, setNewSessionDraftTarget]);

    const handleDraftDirectoryChange = React.useCallback((directory: string) => {
        const draft = useSessionUIStore.getState().newSessionDraft;
        if (draft?.pendingWorktreeRequestId || draft?.bootstrapPendingDirectory) {
            return;
        }
        if (!selectedDraftProject) {
            return;
        }
        if (draft?.preserveDirectoryOverride && normalizePath(directory) === selectedDraftDirectory) {
            return;
        }
        releaseDraftDirectoryPin();
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: directory,
        }, { force: true });
        if (isSpaceDirectory(directory)) useSessionUIStore.getState().setDraftPreserveDirectoryOverride(true);
    }, [selectedDraftDirectory, selectedDraftProject, setNewSessionDraftTarget]);
    return {
        projects,
        selectedDraftProject,
        selectedDraftProjectPath,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges: dirtyDraftDirectory === selectedDraftDirectory,
        projectRootBranchOption,
        worktreeBranchOptions,
        spaceBranchOptions,
        draftBranchItems,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftDirectoryChange,
        refreshDraftTarget,
    };
}
