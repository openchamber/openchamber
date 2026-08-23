/**
 * Choosing where a new session will run.
 *
 * The new-session draft targets a project and a directory within it — the
 * project root or one of its worktrees. Both are discovered lazily: whether a
 * project is even a git repository is unknown until asked, and its branch list
 * is served stale-while-revalidate so a cached list appears instantly and
 * refreshes behind it.
 *
 * The awkward part this hook contains is that the draft can point at a
 * directory that does not exist yet — a worktree being created. Such a
 * directory must survive not appearing in the list, or the selector would snap
 * back to the project root mid-creation and the session would be started in
 * the wrong place.
 */

import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { formatDirectoryName } from '@/lib/utils';
import { useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { buildSessionTargetOptions } from '@/sync/session-worktree-contract';
import { normalizePath } from '../attachments/filePaths';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';

/** How long a cached branch list is served before it is refreshed. */
const BRANCHES_SWR_TTL_MS = 30_000;

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

/** A project's display name, falling back to its directory name. */
export function getProjectDisplayLabel(project: { label?: string; path: string }): string {
    return project.label?.trim() || formatDirectoryName(project.path);
}

export function useDraftTarget(enabled: boolean) {
    const configuredProjects: readonly DraftTargetProject[] = useProjectsStore((state) => state.projects);
    const { t } = useI18n();
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

        // Stale-while-revalidate: branches seeded from the persisted cache show
        // instantly. Refresh based on staleness (not mere presence) so a cached
        // list can't go stale, while only showing the discovering spinner when
        // there is nothing to display yet.
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

    const selectedDraftDirectory = React.useMemo(
        () => normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null)
            ?? normalizePath(newSessionDraft?.directoryOverride ?? null)
            ?? selectedDraftProjectPath,
        [newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.directoryOverride, selectedDraftProjectPath],
    );

    const shouldKeepMissingSelectedDraftDirectory = React.useMemo(() => {
        const pendingDirectory = normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null);
        return Boolean(
            newSessionDraft?.preserveDirectoryOverride
            ||
            newSessionDraft?.pendingWorktreeRequestId
            || (pendingDirectory && pendingDirectory === selectedDraftDirectory)
        );
    }, [newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, selectedDraftDirectory]);

    const draftBranchItems = React.useMemo(() => {
        const baseItems: Array<{ value: string; label: string }> = [];
        if (projectRootBranchOption) {
            baseItems.push(projectRootBranchOption);
        }
        baseItems.push(...worktreeBranchOptions);

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
    }, [projectRootBranchOption, selectedDraftDirectory, shouldKeepMissingSelectedDraftDirectory, worktreeBranchOptions]);

    const selectedDraftBranchLabel = React.useMemo(() => {
        const selectedValue = selectedDraftDirectory ?? draftBranchItems[0]?.value ?? null;
        if (!selectedValue) {
            return null;
        }
        return draftBranchItems.find((item) => item.value === selectedValue)?.label ?? formatDirectoryName(selectedValue);
    }, [draftBranchItems, selectedDraftDirectory]);


    const selectedDraftBranchIsKnown = React.useMemo(() => {
        if (!selectedDraftDirectory) {
            return true;
        }
        if (projectRootBranchOption?.value === selectedDraftDirectory) {
            return true;
        }
        return worktreeBranchOptions.some((option) => option.value === selectedDraftDirectory);
    }, [projectRootBranchOption?.value, selectedDraftDirectory, worktreeBranchOptions]);

    React.useEffect(() => {
        if (!newSessionDraft?.open || !newSessionDraft?.preserveDirectoryOverride) {
            return;
        }
        if (!selectedDraftDirectory || !selectedDraftBranchIsKnown) {
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
        if (draft?.pendingWorktreeRequestId || draft?.bootstrapPendingDirectory || draft?.preserveDirectoryOverride) {
            return;
        }
        const project = projects.find((entry) => entry.id === projectId);
        if (!project) {
            return;
        }
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
    }, [activeProjectId, projects, setActiveProjectIdOnly, setNewSessionDraftTarget]);

    const handleDraftDirectoryChange = React.useCallback((directory: string) => {
        const draft = useSessionUIStore.getState().newSessionDraft;
        if (draft?.pendingWorktreeRequestId || draft?.bootstrapPendingDirectory || draft?.preserveDirectoryOverride) {
            return;
        }
        if (!selectedDraftProject) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: directory,
        }, { force: true });
    }, [selectedDraftProject, setNewSessionDraftTarget]);
    return {
        projects,
        selectedDraftProject,
        selectedDraftProjectPath,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedDraftBranchIsKnown,
        projectRootBranchOption,
        worktreeBranchOptions,
        draftBranchItems,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftDirectoryChange,
    };
}
