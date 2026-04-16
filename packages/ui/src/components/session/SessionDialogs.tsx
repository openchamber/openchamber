import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { RiCheckboxBlankLine, RiCheckboxLine, RiDeleteBinLine, RiGitBranchLine } from '@remixicon/react';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { DirectoryExplorerDialog } from './DirectoryExplorerDialog';
import { cn, formatPathForDisplay } from '@/lib/utils';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import { getWorktreeStatus } from '@/lib/worktrees/worktreeStatus';
import { removeProjectWorktree } from '@/lib/worktrees/worktreeManager';
import { useSessionUIStore } from '@/sync/session-ui-store';
import * as sessionActions from '@/sync/session-actions';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { isDesktopLocalOriginActive, isTauriShell } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { sessionEvents } from '@/lib/sessionEvents';
import { m } from '@/lib/i18n/messages';

const renderToastDescription = (text?: string) =>
    text ? <span className="text-foreground/80 dark:text-foreground/70">{text}</span> : undefined;

const normalizeProjectDirectory = (path: string | null | undefined): string => {
    if (!path) {
        return '';
    }
    const replaced = path.replace(/\\/g, '/');
    if (replaced === '/') {
        return '/';
    }
    return replaced.replace(/\/+$/, '');
};

type DeleteDialogState = {
    sessions: Session[];
    dateLabel?: string;
    mode: 'session' | 'worktree';
    worktree?: WorktreeMetadata | null;
};

export const SessionDialogs: React.FC = () => {
    const [isDirectoryDialogOpen, setIsDirectoryDialogOpen] = React.useState(false);
    const [hasShownInitialDirectoryPrompt, setHasShownInitialDirectoryPrompt] = React.useState(false);
    const [deleteDialog, setDeleteDialog] = React.useState<DeleteDialogState | null>(null);
    const [deleteDialogSummaries, setDeleteDialogSummaries] = React.useState<Array<{ session: Session; metadata: WorktreeMetadata }>>([]);
    const [deleteDialogShouldRemoveRemote, setDeleteDialogShouldRemoveRemote] = React.useState(false);
    const [deleteDialogShouldDeleteLocalBranch, setDeleteDialogShouldDeleteLocalBranch] = React.useState(false);
    const [isProcessingDelete, setIsProcessingDelete] = React.useState(false);
    const [hasCompletedDirtyCheck, setHasCompletedDirtyCheck] = React.useState(false);
    const [dirtyWorktreePaths, setDirtyWorktreePaths] = React.useState<Set<string>>(new Set());

    const getWorktreeMetadata = useSessionUIStore((s) => s.getWorktreeMetadata);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const setDraftBootstrapPendingDirectory = useSessionUIStore((s) => s.setDraftBootstrapPendingDirectory);
    const deleteSession = sessionActions.deleteSession;
    const archiveSession = sessionActions.archiveSession;
    const deleteSessions = useSessionUIStore((s) => s.deleteSessions);
    const archiveSessions = useSessionUIStore((s) => s.archiveSessions);
    const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
    const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
    const { currentDirectory, homeDirectory, isHomeReady } = useDirectoryStore();
    const { projects, addProject, activeProjectId } = useProjectsStore();
    const { requestAccess, startAccessing } = useFileSystemAccess();
    const { isMobile, isTablet, hasTouchInput } = useDeviceInfo();
    const useMobileOverlay = isMobile || isTablet || hasTouchInput;

    const projectDirectory = React.useMemo(() => {
        const targetProject = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        const targetPath = targetProject?.path ?? currentDirectory;
        return normalizeProjectDirectory(targetPath);
    }, [activeProjectId, currentDirectory, projects]);

    const getProjectRefForWorktree = React.useCallback((worktree: WorktreeMetadata) => {
        const normalized = normalizeProjectDirectory(worktree.projectDirectory);
        const fallbackPath = normalized || projectDirectory;
        const match = projects.find((project) => normalizeProjectDirectory(project.path) === fallbackPath) ?? null;
        return { id: match?.id ?? `path:${fallbackPath}`, path: fallbackPath };
    }, [projectDirectory, projects]);

    const hasDirtyWorktrees = hasCompletedDirtyCheck && dirtyWorktreePaths.size > 0;
    const canRemoveRemoteBranches = React.useMemo(
        () => {
            const targetWorktree = deleteDialog?.worktree;
            if (targetWorktree && typeof targetWorktree.branch === 'string' && targetWorktree.branch.trim().length > 0) {
                return true;
            }
            return (
                deleteDialogSummaries.length > 0 &&
                deleteDialogSummaries.every(({ metadata }) => typeof metadata.branch === 'string' && metadata.branch.trim().length > 0)
            );
        },
        [deleteDialog?.worktree, deleteDialogSummaries],
    );
    const isWorktreeDelete = deleteDialog?.mode === 'worktree';
    const shouldArchiveWorktree = isWorktreeDelete;
    const removeRemoteOptionDisabled =
        isProcessingDelete || !isWorktreeDelete || !canRemoveRemoteBranches;
    const deleteLocalOptionDisabled = isProcessingDelete || !isWorktreeDelete;

    // Session loading is handled by sync bootstrap — no manual loadSessions needed.

    React.useEffect(() => {
        if (hasShownInitialDirectoryPrompt || !isHomeReady || projects.length > 0) {
            return;
        }

        setHasShownInitialDirectoryPrompt(true);

        if (isTauriShell() && isDesktopLocalOriginActive()) {
            requestAccess('')
                .then(async (result) => {
                    if (!result.success || !result.path) {
                        if (result.error && result.error !== 'Directory selection cancelled') {
                            toast.error(m.sdFailedToSelectDirectory(), {
                                description: result.error,
                            });
                        }
                        return;
                    }

                    const accessResult = await startAccessing(result.path);
                    if (!accessResult.success) {
                        toast.error(m.sdFailedToOpenDirectory(), {
                            description: accessResult.error || m.sdDesktopCouldNotGrantFileAccess(),
                        });
                        return;
                    }

                    const added = addProject(result.path, { id: result.projectId });
                    if (!added) {
                        toast.error(m.sdFailedToAddProject(), {
                            description: m.sdPleaseSelectAValidDirectoryPath(),
                        });
                    }
                })
                .catch((error) => {
                    console.error('Desktop: Error selecting directory:', error);
                    toast.error(m.sdFailedToSelectDirectory());
                });
            return;
        }

        setIsDirectoryDialogOpen(true);
    }, [
        addProject,
        hasShownInitialDirectoryPrompt,
        isHomeReady,
        projects.length,
        requestAccess,
        startAccessing,
    ]);

    const openDeleteDialog = React.useCallback((payload: { sessions: Session[]; dateLabel?: string; mode?: 'session' | 'worktree'; worktree?: WorktreeMetadata | null }) => {
        setDeleteDialog({
            sessions: payload.sessions,
            dateLabel: payload.dateLabel,
            mode: payload.mode ?? 'session',
            worktree: payload.worktree ?? null,
        });
    }, []);

    const closeDeleteDialog = React.useCallback(() => {
        setDeleteDialog(null);
        setDeleteDialogSummaries([]);
        setDeleteDialogShouldRemoveRemote(false);
        setDeleteDialogShouldDeleteLocalBranch(false);
        setIsProcessingDelete(false);
        setHasCompletedDirtyCheck(false);
        setDirtyWorktreePaths(new Set());
    }, []);

    const deleteSessionsWithoutDialog = React.useCallback(async (payload: { sessions: Session[]; dateLabel?: string }) => {
        if (payload.sessions.length === 0) {
            return;
        }

        if (payload.sessions.length === 1) {
            const target = payload.sessions[0];
            const success = await deleteSession(target.id);
            if (success) {
                toast.success(m.sdSessionDeleted());
            } else {
                toast.error(m.sdFailedToDeleteSession());
            }
            return;
        }

        const ids = payload.sessions.map((session) => session.id);
        const { deletedIds, failedIds } = await deleteSessions(ids);

        if (deletedIds.length > 0) {
            const successDescription = failedIds.length > 0
                ? m.sdSessionsCouldNotBeDeleted({ count: failedIds.length })
                : payload.dateLabel
                    ? m.sdRemovedAllSessionsFromDate({ date: payload.dateLabel })
                    : undefined;
            toast.success(m.sdDeletedSessions({ count: deletedIds.length }), {
                description: renderToastDescription(successDescription),
            });
        }

        if (failedIds.length > 0) {
            toast.error(m.sdFailedToDeleteSessions({ count: failedIds.length }), {
                description: renderToastDescription(m.sdPleaseTryAgain()),
            });
        }
    }, [deleteSession, deleteSessions]);

    React.useEffect(() => {
        return sessionEvents.onDeleteRequest((payload) => {
            if (!showDeletionDialog && (payload.mode ?? 'session') === 'session') {
                void deleteSessionsWithoutDialog(payload);
                return;
            }
            openDeleteDialog(payload);
        });
    }, [openDeleteDialog, showDeletionDialog, deleteSessionsWithoutDialog]);

    React.useEffect(() => {
        return sessionEvents.onDirectoryRequest(() => {
            setIsDirectoryDialogOpen(true);
        });
    }, []);

    React.useEffect(() => {
        if (!deleteDialog) {
            setDeleteDialogSummaries([]);
            setDeleteDialogShouldRemoveRemote(false);
            setDeleteDialogShouldDeleteLocalBranch(false);
            setHasCompletedDirtyCheck(false);
            setDirtyWorktreePaths(new Set());
            return;
        }

        const summaries = deleteDialog.sessions
            .map((session) => {
                const metadata = getWorktreeMetadata(session.id);
                return metadata ? { session, metadata } : null;
            })
            .filter((entry): entry is { session: Session; metadata: WorktreeMetadata } => Boolean(entry));

        setDeleteDialogSummaries(summaries);
        setDeleteDialogShouldRemoveRemote(false);
        setHasCompletedDirtyCheck(false);
        setDirtyWorktreePaths(new Set());

        const metadataByPath = new Map<string, WorktreeMetadata>();
        if (deleteDialog.worktree?.path) {
            metadataByPath.set(normalizeProjectDirectory(deleteDialog.worktree.path), deleteDialog.worktree);
        }
        summaries.forEach(({ metadata }) => {
            if (metadata.path) {
                metadataByPath.set(normalizeProjectDirectory(metadata.path), metadata);
            }
        });

        if (metadataByPath.size === 0) {
            setHasCompletedDirtyCheck(true);
            return;
        }

        let cancelled = false;

        (async () => {
            const statusByPath = new Map<string, WorktreeMetadata['status']>();
            const nextDirtyPaths = new Set<string>();

            await Promise.all(
                Array.from(metadataByPath.entries()).map(async ([pathKey, metadata]) => {
                    try {
                        const status = await getWorktreeStatus(metadata.path);
                        statusByPath.set(pathKey, status);
                        if (status?.isDirty) {
                            nextDirtyPaths.add(pathKey);
                        }
                    } catch {
                        if (metadata.status) {
                            statusByPath.set(pathKey, metadata.status);
                            if (metadata.status.isDirty) {
                                nextDirtyPaths.add(pathKey);
                            }
                        }
                    }
                })
            ).catch((error) => {
                console.warn('Failed to inspect worktree status before deletion:', error);
            });

            if (cancelled) {
                return;
            }

            setDirtyWorktreePaths(nextDirtyPaths);
            setHasCompletedDirtyCheck(true);

            setDeleteDialog((prev) => {
                if (!prev?.worktree?.path) {
                    return prev;
                }
                const pathKey = normalizeProjectDirectory(prev.worktree.path);
                const nextStatus = statusByPath.get(pathKey);
                if (!nextStatus) {
                    return prev;
                }
                const prevStatus = prev.worktree.status;
                if (
                    prevStatus?.isDirty === nextStatus.isDirty &&
                    prevStatus?.ahead === nextStatus.ahead &&
                    prevStatus?.behind === nextStatus.behind &&
                    prevStatus?.upstream === nextStatus.upstream
                ) {
                    return prev;
                }
                return {
                    ...prev,
                    worktree: {
                        ...prev.worktree,
                        status: nextStatus,
                    },
                };
            });

            setDeleteDialogSummaries((prev) =>
                prev.map((entry) => {
                    const pathKey = normalizeProjectDirectory(entry.metadata.path);
                    const nextStatus = statusByPath.get(pathKey);
                    if (!nextStatus) {
                        return entry;
                    }
                    return {
                        session: entry.session,
                        metadata: { ...entry.metadata, status: nextStatus },
                    };
                })
            );
        })();

        return () => {
            cancelled = true;
        };
    }, [deleteDialog, getWorktreeMetadata]);

    React.useEffect(() => {
        if (!canRemoveRemoteBranches) {
            setDeleteDialogShouldRemoveRemote(false);
        }
    }, [canRemoveRemoteBranches]);

    const removeSelectedWorktree = React.useCallback(async (
        worktree: WorktreeMetadata,
        deleteLocalBranch: boolean
    ): Promise<boolean> => {
        const shouldRemoveRemote = deleteDialogShouldRemoveRemote && canRemoveRemoteBranches;
        const projectRef = getProjectRefForWorktree(worktree);
        const normalizedWorktreePath = normalizeProjectDirectory(worktree.path);
        const normalizedProjectPath = normalizeProjectDirectory(projectRef.path);
        try {
            await removeProjectWorktree(
                projectRef,
                worktree,
                { deleteRemoteBranch: shouldRemoveRemote, deleteLocalBranch }
            );

            const draftDirectory = normalizeProjectDirectory(newSessionDraft?.directoryOverride);
            if (
                newSessionDraft?.open
                && normalizedWorktreePath
                && draftDirectory === normalizedWorktreePath
                && normalizedProjectPath
            ) {
                setDraftBootstrapPendingDirectory(null);
                setNewSessionDraftTarget({
                    projectId: projectRef.id,
                    directoryOverride: normalizedProjectPath,
                }, { force: true });
            }

            if (normalizeProjectDirectory(currentDirectory) === normalizedWorktreePath && normalizedProjectPath) {
                useDirectoryStore.getState().setDirectory(normalizedProjectPath, { showOverlay: false });
            }

            return true;
        } catch (error) {
            toast.error(m.sdFailedToRemoveWorktree(), {
                description: renderToastDescription(error instanceof Error ? error.message : m.sdPleaseTryAgain()),
            });
            return false;
        }
    }, [canRemoveRemoteBranches, currentDirectory, deleteDialogShouldRemoveRemote, getProjectRefForWorktree, newSessionDraft?.directoryOverride, newSessionDraft?.open, setDraftBootstrapPendingDirectory, setNewSessionDraftTarget]);

    const handleConfirmDelete = React.useCallback(async () => {
        if (!deleteDialog) {
            return;
        }
        setIsProcessingDelete(true);

        try {
            const shouldArchive = shouldArchiveWorktree;
            const removeRemoteBranch = shouldArchive && deleteDialogShouldRemoveRemote;
            const deleteLocalBranch = shouldArchive && deleteDialogShouldDeleteLocalBranch;

            if (deleteDialog.sessions.length === 0 && isWorktreeDelete && deleteDialog.worktree) {
                const removed = await removeSelectedWorktree(deleteDialog.worktree, deleteLocalBranch);
                if (!removed) {
                    closeDeleteDialog();
                    return;
                }
                const shouldRemoveRemote = deleteDialogShouldRemoveRemote && canRemoveRemoteBranches;
                const archiveNote = shouldRemoveRemote
                    ? m.sdWorktreeAndRemoteBranchRemoved()
                    : m.sdWorktreeRemoved();
                toast.success(m.sdWorktreeRemoved(), {
                    description: renderToastDescription(archiveNote),
                });
                closeDeleteDialog();
                return;
            }

            if (deleteDialog.sessions.length === 1) {
                const target = deleteDialog.sessions[0];
                const success = isWorktreeDelete
                    ? await archiveSession(target.id)
                    : await deleteSession(target.id, {
                        // In "worktree" mode, remove the selected worktree explicitly below.
                        // Don't try to derive worktree removal from per-session metadata (may be missing).
                        archiveWorktree: false,
                        deleteRemoteBranch: removeRemoteBranch,
                        deleteLocalBranch,
                    });
                if (!success) {
                    toast.error(isWorktreeDelete ? m.sdFailedToArchiveSession() : m.sdFailedToDeleteSession());
                    setIsProcessingDelete(false);
                    return;
                }
                const archiveNote = !isWorktreeDelete && shouldArchive
                    ? removeRemoteBranch
                        ? m.sdWorktreeAndRemoteBranchRemoved()
                        : m.sdAttachedWorktreeArchived()
                    : undefined;
                toast.success(isWorktreeDelete ? m.sdSessionArchived() : m.sdSessionDeleted(), {
                    description: renderToastDescription(archiveNote),
                    action: {
                        label: m.sdOk(),
                        onClick: () => { },
                    },
                });
            } else {
                const ids = deleteDialog.sessions.map((session) => session.id);
                let deletedIds: string[] = [];
                let failedIds: string[] = [];
                if (isWorktreeDelete) {
                    const result = await archiveSessions(ids);
                    deletedIds = result.archivedIds;
                    failedIds = result.failedIds;
                } else {
                    const result = await deleteSessions(ids, {
                        archiveWorktree: false,
                        deleteRemoteBranch: removeRemoteBranch,
                        deleteLocalBranch,
                    });
                    deletedIds = result.deletedIds;
                    failedIds = result.failedIds;
                }

                if (isWorktreeDelete && deleteDialog.worktree && failedIds.length === 0) {
                    // Remove selected worktree even if per-session metadata is missing.
                    // Use same projectRef logic as the no-sessions path.
                    await removeSelectedWorktree(deleteDialog.worktree, deleteLocalBranch);
                    // sync handles session refresh automatically
                }

                if (deletedIds.length > 0) {
                    const archiveNote = !isWorktreeDelete && shouldArchive
                        ? removeRemoteBranch
                            ? m.sdArchivedWorktreesAndRemovedRemoteBranches()
                            : m.sdAttachedWorktreesArchived()
                        : undefined;
                    const successDescription =
                        failedIds.length > 0
                            ? m.sdSessionsCouldNotBeArchivedOrDeleted({ count: failedIds.length, action: isWorktreeDelete ? 'archived' : 'deleted' })
                            : deleteDialog.dateLabel
                                ? m.sdRemovedAllSessionsFromDate({ date: deleteDialog.dateLabel })
                                : undefined;
                    const combinedDescription = [successDescription, archiveNote].filter(Boolean).join(' ');
                    toast.success(m.sdArchivedOrDeletedSessions({ action: isWorktreeDelete ? 'Archived' : 'Deleted', count: deletedIds.length }), {
                        description: renderToastDescription(combinedDescription || undefined),
                        action: {
                            label: m.sdOk(),
                            onClick: () => { },
                        },
                    });
                }

                if (failedIds.length > 0) {
                    toast.error(m.sdFailedToArchiveOrDeleteSessions({ action: isWorktreeDelete ? 'archive' : 'delete', count: failedIds.length }), {
                        description: renderToastDescription(m.sdPleaseTryAgain()),
                    });
                    if (deletedIds.length === 0) {
                        setIsProcessingDelete(false);
                        return;
                    }
                }
            }

            if (isWorktreeDelete && deleteDialog.sessions.length === 1 && deleteDialog.worktree) {
                await removeSelectedWorktree(deleteDialog.worktree, deleteLocalBranch);
                // sync bootstrap refreshes sessions automatically
            }

            closeDeleteDialog();
        } finally {
            setIsProcessingDelete(false);
        }
    }, [
        deleteDialog,
        deleteDialogShouldRemoveRemote,
        deleteDialogShouldDeleteLocalBranch,
        deleteSession,
        deleteSessions,
        archiveSession,
        archiveSessions,
        closeDeleteDialog,
        shouldArchiveWorktree,
        isWorktreeDelete,
        canRemoveRemoteBranches,
        removeSelectedWorktree,
    ]);

    const targetWorktree = deleteDialog?.worktree ?? deleteDialogSummaries[0]?.metadata ?? null;
    const deleteDialogDescription = deleteDialog
        ? deleteDialog.mode === 'worktree'
            ? deleteDialog.sessions.length === 0
                ? m.sdThisRemovesTheSelectedWorktree()
                : m.sdThisRemovesWorktreeAndArchivesSessions({ count: deleteDialog.sessions.length })
            : m.sdThisPermanentlyRemovesSessions({ count: deleteDialog.sessions.length, dateLabel: deleteDialog.dateLabel })
        : '';

    const deleteDialogBody = deleteDialog ? (
        <div className={cn(isWorktreeDelete ? 'space-y-3' : 'space-y-2')}>
            {deleteDialog.sessions.length > 0 && (
                <div className={cn(
                    isWorktreeDelete ? 'rounded-lg bg-muted/30 p-3' : 'space-y-1.5 rounded-xl border border-border/40 bg-sidebar/60 p-3'
                )}>
                    {isWorktreeDelete && (
                        <div className="flex items-center gap-2">
                            <span className="typography-meta font-medium text-foreground">
                                {deleteDialog.sessions.length === 1 ? m.sdLinkedSession() : m.sdLinkedSessions()}
                            </span>
                            <span className="typography-micro text-muted-foreground/70">
                                {deleteDialog.sessions.length}
                            </span>
                        </div>
                    )}
                    <ul className={cn(isWorktreeDelete ? 'mt-2 space-y-1' : 'space-y-0.5')}>
                        {deleteDialog.sessions.slice(0, 5).map((session) => (
                            <li
                                key={session.id}
                                className={cn(
                                    isWorktreeDelete
                                        ? 'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground'
                                        : 'typography-micro text-muted-foreground/80'
                                )}
                            >
                                <span className={cn(!isWorktreeDelete && 'hidden')}>
                                    •
                                </span>
                                <span className="truncate">
                                    {session.title || m.sdUntitledSession()}
                                </span>
                            </li>
                        ))}
                        {deleteDialog.sessions.length > 5 && (
                            <li className={cn(
                                isWorktreeDelete
                                    ? 'px-2.5 py-1 text-xs text-muted-foreground/70'
                                    : 'typography-micro text-muted-foreground/70'
                            )}>
                                +{deleteDialog.sessions.length - 5} more
                            </li>
                        )}
                    </ul>
                </div>
            )}

            {isWorktreeDelete ? (
                <div className="space-y-2 rounded-lg bg-muted/30 p-3">
                    <div className="flex items-center gap-2">
                        <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
                        <span className="typography-meta font-medium text-foreground">{m.sdWorktree()}</span>
                        {targetWorktree?.label ? (
                            <span className="typography-micro text-muted-foreground/70">{targetWorktree.label}</span>
                        ) : null}
                    </div>
                    <p className="typography-micro text-muted-foreground/80 break-all">
                        {targetWorktree ? formatPathForDisplay(targetWorktree.path, homeDirectory) : m.sdWorktreePathUnavailable()}
                    </p>
                    {hasDirtyWorktrees && (
                        <p className="typography-micro text-status-warning">{m.sdUncommittedChangesWillBeDiscarded()}</p>
                    )}

                </div>
            ) : (
                <div className="rounded-xl border border-border/40 bg-sidebar/60 p-3">
                    <p className="typography-meta text-muted-foreground/80">
                        {m.sdWorktreeDirectoriesStayIntact()}
                    </p>
                </div>
            )}
        </div>
    ) : null;

    const deleteRemoteBranchAction = isWorktreeDelete ? (
        canRemoveRemoteBranches ? (
            <button
                type="button"
                onClick={() => {
                    if (removeRemoteOptionDisabled) {
                        return;
                    }
                    setDeleteDialogShouldRemoveRemote((prev) => !prev);
                }}
                disabled={removeRemoteOptionDisabled}
                className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors',
                    removeRemoteOptionDisabled
                        ? 'cursor-not-allowed opacity-60'
                        : 'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                )}
            >
                {deleteDialogShouldRemoveRemote ? (
                    <RiCheckboxLine className="size-4 text-primary" />
                ) : (
                    <RiCheckboxBlankLine className="size-4" />
                )}
                {m.sdDeleteRemoteBranch()}
            </button>
        ) : (
            <span className="text-xs text-muted-foreground/70">{m.sdRemoteBranchInfoUnavailable()}</span>
        )
    ) : null;

    const deleteLocalBranchAction = isWorktreeDelete ? (
        <button
            type="button"
            onClick={() => {
                if (deleteLocalOptionDisabled) {
                    return;
                }
                setDeleteDialogShouldDeleteLocalBranch((prev) => !prev);
            }}
            disabled={deleteLocalOptionDisabled}
            className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors',
                deleteLocalOptionDisabled
                    ? 'cursor-not-allowed opacity-60'
                    : 'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
            )}
        >
            {deleteDialogShouldDeleteLocalBranch ? (
                <RiCheckboxLine className="size-4 text-primary" />
            ) : (
                <RiCheckboxBlankLine className="size-4" />
            )}
            {m.sdDeleteLocalBranch()}
        </button>
    ) : null;

    const deleteDialogActions = isWorktreeDelete ? (
        <div className="flex w-full items-center justify-between gap-3">
            <div className="flex flex-col items-start gap-1">
                {deleteLocalBranchAction}
                {deleteRemoteBranchAction}
            </div>
            <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={closeDeleteDialog} disabled={isProcessingDelete}>
                    {m.sdCancel()}
                </Button>
                <Button variant="destructive" onClick={handleConfirmDelete} disabled={isProcessingDelete}>
                    {isProcessingDelete ? m.sdDeleting() : m.sdDeleteWorktree()}
                </Button>
            </div>
        </div>
    ) : (
        <div className="flex w-full items-center justify-between gap-3">
            <button
                type="button"
                onClick={() => setShowDeletionDialog(!showDeletionDialog)}
                className="inline-flex items-center gap-1.5 typography-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                aria-pressed={!showDeletionDialog}
            >
                {!showDeletionDialog ? <RiCheckboxLine className="size-4 text-primary" /> : <RiCheckboxBlankLine className="size-4" />}
                {m.sdNeverAsk()}
            </button>
            <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={closeDeleteDialog} disabled={isProcessingDelete}>
                    {m.sdCancel()}
                </Button>
                <Button variant="destructive" onClick={handleConfirmDelete} disabled={isProcessingDelete}>
                    {isProcessingDelete
                        ? m.sdDeleting()
                        : deleteDialog?.sessions.length === 1
                            ? m.sdDeleteSession()
                            : m.sdDeleteSessions()}
                </Button>
            </div>
        </div>
    );

    const deleteDialogTitle = isWorktreeDelete
        ? m.sdDeleteWorktree()
        : deleteDialog?.sessions.length === 1
            ? m.sdDeleteSession()
            : m.sdDeleteSessions();

    return (
        <>
            {useMobileOverlay ? (
                <MobileOverlayPanel
                    open={Boolean(deleteDialog)}
                    onClose={() => {
                        if (isProcessingDelete) {
                            return;
                        }
                        closeDeleteDialog();
                    }}
                    title={deleteDialogTitle}
                    footer={<div className="flex justify-end gap-2">{deleteDialogActions}</div>}
                >
                    <div className="space-y-2 pb-2">
                        {deleteDialogDescription && (
                            <p className="typography-meta text-muted-foreground/80">{deleteDialogDescription}</p>
                        )}
                        {deleteDialogBody}
                    </div>
                </MobileOverlayPanel>
            ) : (
                <Dialog
                    open={Boolean(deleteDialog)}
                    onOpenChange={(open) => {
                        if (!open) {
                            if (isProcessingDelete) {
                                return;
                            }
                            closeDeleteDialog();
                        }
                    }}
                >
                    <DialogContent
                        className={cn(
                            isWorktreeDelete
                                ? 'max-w-xl max-h-[70vh] flex flex-col overflow-hidden gap-3'
                                : 'max-w-[min(520px,100vw-2rem)] space-y-2 pb-2'
                        )}
                    >
                        <DialogHeader>
                            <DialogTitle className={cn(isWorktreeDelete && 'flex items-center gap-2')}>
                                {isWorktreeDelete && <RiDeleteBinLine className="h-5 w-5" />}
                                {deleteDialogTitle}
                            </DialogTitle>
                            {deleteDialogDescription && <DialogDescription>{deleteDialogDescription}</DialogDescription>}
                        </DialogHeader>
                        <div className={cn(isWorktreeDelete && 'flex-1 min-h-0 overflow-y-auto space-y-2')}>
                            {deleteDialogBody}
                        </div>
                        <DialogFooter className="mt-2 gap-2 pt-1 pb-1">{deleteDialogActions}</DialogFooter>
                    </DialogContent>
                </Dialog>
            )}

            <DirectoryExplorerDialog
                open={isDirectoryDialogOpen}
                onOpenChange={setIsDirectoryDialogOpen}
            />
        </>
    );
};
