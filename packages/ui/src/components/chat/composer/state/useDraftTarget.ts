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
import { spacesOfProject, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';

/** How long a cached branch list is served before it is refreshed. */
const BRANCHES_SWR_TTL_MS = 30_000;
/** Minimum gap between user-triggered Git refreshes of the draft target. */
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

/**
 * A pinned directory (`preserveDirectoryOverride`) stops the app from moving
 * the draft while the directory is unconfirmed; it never overrides the user's
 * own pick. The pin only clears by itself once the directory shows up as a
 * known branch, which a project without git never does.
 */
function releaseDraftDirectoryPin() {
    const store = useSessionUIStore.getState();
    if (store.newSessionDraft?.preserveDirectoryOverride) {
        store.setDraftPreserveDirectoryOverride(false);
    }
}

/** A project's display name, falling back to its directory name. */
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
            // A worktree creation that started while this list was read owns the
            // published list now: this list may not hold the new worktree yet.
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

    // The branch list carries a staleness window but no timer, so a branch
    // changed outside OpenChamber stayed visible until the project changed.
    // Refresh when the window comes back into view and when the picker opens;
    // a hidden composer does no work.
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

    // A new project starts with a fresh budget: its first focus must not ride
    // out a throttle opened for the project just left.
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

    // The project's isolated spaces a new chat can start in: made, running or stopped (a send
    // to a stopped one offers to start it). One being made is reached through its own draft.
    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
    const spaceBranchOptions = React.useMemo(() => {
        if (!isolatedSpacesEnabled || !spacesJourney || !selectedDraftProjectPath) return [];
        return spacesOfProject(spacesJourney, selectedDraftProjectPath).flatMap((entry) => {
            const value = normalizePath(entry.directory);
            if (!value || (entry.state !== 'running' && entry.state !== 'exited')) return [];
            return [{ value, label: entry.name || t('sessions.sidebar.grouping.spaceUnnamed') }];
        });
    }, [isolatedSpacesEnabled, selectedDraftProjectPath, spacesJourney, t]);

    // A draft waiting for a new space stays on the project's folder until its message is sent
    // (`space-creation.ts`), but it is the space's draft: once the space runs, the picker shows
    // and checks the space, and the dirty check reads the space's tree.
    const draftSpace = draftSpaceTarget(newSessionDraft?.pendingWorktreeRequestId, spacesJourney);
    const draftSpaceDirectory = draftSpace?.kind === 'ready' ? normalizePath(draftSpace.directory) : null;
    const selectedDraftDirectory = React.useMemo(
        () => draftSpaceDirectory
            ?? normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null)
            ?? normalizePath(newSessionDraft?.directoryOverride ?? null)
            ?? selectedDraftProjectPath,
        [draftSpaceDirectory, newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.directoryOverride, selectedDraftProjectPath],
    );

    // The draft's own pending flags clear once the directory exists, which is
    // before setup commands and the initial git reset finish; the bootstrap
    // state covers that remaining window (and creations the draft never knew
    // about, such as the New Worktree dialog), so the probe never reads the
    // transient bootstrap files as the branch being dirty.
    const selectedDraftDirectoryBootstrapPending = useWorktreeBootstrapPending(selectedDraftDirectory);
    const draftDirectoryNeedsFreshStatusRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (
            !enabled
            || !selectedDraftDirectory
            || selectedDraftProject?.kind === 'chat'
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
            // Git lists a created worktree only once its background attach
            // finishes, so a refresh inside that window omits it.
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
        // A space's directory keeps its pin while listed: it exists inside the space only, so
        // without the pin the host's probe at send would call it missing and start the chat in
        // the project instead.
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
        // Re-picking the shown project would move a pinned space or worktree
        // draft to the project root, so it changes nothing.
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
        // Without its pin an unlisted directory leaves the list and the draft
        // snaps to the project root, so re-picking it changes nothing.
        if (draft?.preserveDirectoryOverride && normalizePath(directory) === selectedDraftDirectory) {
            return;
        }
        releaseDraftDirectoryPin();
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: directory,
        }, { force: true });
        // Picked from the list, a space is pinned as the sidebar's new chat in it is (see above).
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
