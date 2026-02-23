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
import { useSessionStore } from '@/stores/useSessionStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { isDesktopLocalOriginActive, isTauriShell } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { sessionEvents } from '@/lib/sessionEvents';

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

    const {
        deleteSession,
        deleteSessions,
        loadSessions,
        getWorktreeMetadata,
    } = useSessionStore();
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

    React.useEffect(() => {
        loadSessions();
    }, [loadSessions, currentDirectory]);

    const projectsKey = React.useMemo(
        () => projects.map((project) => `${project.id}:${project.path}`).join('|'),
        [projects],
    );
    const lastProjectsKeyRef = React.useRef(projectsKey);

    React.useEffect(() => {
        if (projectsKey === lastProjectsKeyRef.current) {
            return;
        }

        lastProjectsKeyRef.current = projectsKey;
        loadSessions();
    }, [loadSessions, projectsKey]);

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
                            toast.error('Failed to select directory', {
                                description: result.error,
                            });
                        }
                        return;
                    }

                    const accessResult = await startAccessing(result.path);
                    if (!accessResult.success) {
                        toast.error('Failed to open directory', {
                            description: accessResult.error || 'Desktop could not grant file access.',
                        });
                        return;
                    }

                    const added = addProject(result.path, { id: result.projectId });
                    if (!added) {
                        toast.error('Failed to add project', {
                            description: 'Please select a valid directory path.',
                        });
                    }
                })
                .catch((error) => {
                    console.error('Desktop: Error selecting directory:', error);
                    toast.error('Failed to select directory');
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
                toast.success('Session deleted');
            } else {
                toast.error('Failed to delete session');
            }
            return;
        }

        const ids = payload.sessions.map((session) => session.id);
        const { deletedIds, failedIds } = await deleteSessions(ids);

        if (deletedIds.length > 0) {
            const successDescription = failedIds.length > 0
                ? `${failedIds.length} session${failedIds.length === 1 ? '' : 's'} could not be deleted.`
                : payload.dateLabel
                    ? `Removed all sessions from ${payload.dateLabel}.`
                    : undefined;
            toast.success(`Deleted ${deletedIds.length} session${deletedIds.length === 1 ? '' : 's'}`, {
                description: renderToastDescription(successDescription),
            });
        }

        if (failedIds.length > 0) {
            toast.error(`Failed to delete ${failedIds.length} session${failedIds.length === 1 ? '' : 's'}`, {
                description: renderToastDescription('Please try again in a moment.'),
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
        try {
            await removeProjectWorktree(
                getProjectRefForWorktree(worktree),
                worktree,
                { deleteRemoteBranch: shouldRemoveRemote, deleteLocalBranch }
            );
            return true;
        } catch (error) {
            toast.error('Failed to remove worktree', {
                description: renderToastDescription(error instanceof Error ? error.message : 'Please try again.'),
            });
            return false;
        }
    }, [canRemoveRemoteBranches, deleteDialogShouldRemoveRemote, getProjectRefForWorktree]);

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
                const archiveNote = shouldRemoveRemote ? 'Worktree and remote branch removed.' : 'Worktree removed.';
                toast.success('Worktree removed', {
                    description: renderToastDescription(archiveNote),
                });
                closeDeleteDialog();
                loadSessions();
                return;
            }

            if (deleteDialog.sessions.length === 1) {
                const target = deleteDialog.sessions[0];
                const success = await deleteSession(target.id, {
                    // In "worktree" mode, remove the selected worktree explicitly below.
                    // Don't try to derive worktree removal from per-session metadata (may be missing).
                    archiveWorktree: isWorktreeDelete ? false : shouldArchive,
                    deleteRemoteBranch: removeRemoteBranch,
                    deleteLocalBranch,
                });
                if (!success) {
                    toast.error('Failed to delete session');
                    setIsProcessingDelete(false);
                    return;
                }
                const archiveNote = !isWorktreeDelete && shouldArchive
                    ? removeRemoteBranch
                        ? 'Worktree and remote branch removed.'
                        : 'Attached worktree archived.'
                    : undefined;
                toast.success('Session deleted', {
                    description: renderToastDescription(archiveNote),
                    action: {
                        label: 'OK',
                        onClick: () => { },
                    },
                });
            } else {
                const ids = deleteDialog.sessions.map((session) => session.id);
                const { deletedIds, failedIds } = await deleteSessions(ids, {
                    archiveWorktree: isWorktreeDelete ? false : shouldArchive,
                    deleteRemoteBranch: removeRemoteBranch,
                    deleteLocalBranch,
                });

                if (isWorktreeDelete && deleteDialog.worktree && failedIds.length === 0) {
                    // Remove selected worktree even if per-session metadata is missing.
                    // Use same projectRef logic as the no-sessions path.
                    const removed = await removeSelectedWorktree(deleteDialog.worktree, deleteLocalBranch);
                    if (removed) {
                        await loadSessions();
                    }
                }

                if (deletedIds.length > 0) {
                    const archiveNote = !isWorktreeDelete && shouldArchive
                        ? removeRemoteBranch
                            ? 'Archived worktrees and removed remote branches.'
                            : 'Attached worktrees archived.'
                        : undefined;
                    const successDescription =
                        failedIds.length > 0
                            ? `${failedIds.length} session${failedIds.length === 1 ? '' : 's'} could not be deleted.`
                            : deleteDialog.dateLabel
                                ? `Removed all sessions from ${deleteDialog.dateLabel}.`
                                : undefined;
                    const combinedDescription = [successDescription, archiveNote].filter(Boolean).join(' ');
                    toast.success(`Deleted ${deletedIds.length} session${deletedIds.length === 1 ? '' : 's'}`, {
                        description: renderToastDescription(combinedDescription || undefined),
                        action: {
                            label: 'OK',
                            onClick: () => { },
                        },
                    });
                }

                if (failedIds.length > 0) {
                    toast.error(`Failed to delete ${failedIds.length} session${failedIds.length === 1 ? '' : 's'}`, {
                        description: renderToastDescription('Please try again in a moment.'),
                    });
                    if (deletedIds.length === 0) {
                        setIsProcessingDelete(false);
                        return;
                    }
                }
            }

            if (isWorktreeDelete && deleteDialog.sessions.length === 1 && deleteDialog.worktree) {
                const removed = await removeSelectedWorktree(deleteDialog.worktree, deleteLocalBranch);
                if (removed) {
                    await loadSessions();
                }
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
        closeDeleteDialog,
        shouldArchiveWorktree,
        isWorktreeDelete,
        canRemoveRemoteBranches,
        removeSelectedWorktree,
        loadSessions,
    ]);

    const targetWorktree = deleteDialog?.worktree ?? deleteDialogSummaries[0]?.metadata ?? null;
    const deleteDialogDescription = deleteDialog
        ? deleteDialog.mode === 'worktree'
            ? deleteDialog.sessions.length === 0
                ? 'This removes the selected worktree.'
                : `This removes the selected worktree and ${deleteDialog.sessions.length === 1 ? '1 linked session' : `${deleteDialog.sessions.length} linked sessions`}.`
            : `This action permanently removes ${deleteDialog.sessions.length === 1 ? '1 session' : `${deleteDialog.sessions.length} sessions`}${deleteDialog.dateLabel ? ` from ${deleteDialog.dateLabel}` : ''
            }.`
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
                                {deleteDialog.sessions.length === 1 ? 'Linked session' : 'Linked sessions'}
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
                                    {session.title || 'Untitled Session'}
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
                        <span className="typography-meta font-medium text-foreground">Worktree</span>
                        {targetWorktree?.label ? (
                            <span className="typography-micro text-muted-foreground/70">{targetWorktree.label}</span>
                        ) : null}
                    </div>
                    <p className="typography-micro text-muted-foreground/80 break-all">
                        {targetWorktree ? formatPathForDisplay(targetWorktree.path, homeDirectory) : 'Worktree path unavailable.'}
                    </p>
                    {hasDirtyWorktrees && (
                        <p className="typography-micro text-status-warning">Uncommitted changes will be discarded.</p>
                    )}

                </div>
            ) : (
                <div className="rounded-xl border border-border/40 bg-sidebar/60 p-3">
                    <p className="typography-meta text-muted-foreground/80">
                        Worktree directories stay intact. Subsessions linked to the selected sessions will also be removed.
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
                Delete remote branch
            </button>
        ) : (
            <span className="text-xs text-muted-foreground/70">Remote branch info unavailable</span>
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
            Delete local branch
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
                    Cancel
                </Button>
                <Button variant="destructive" onClick={handleConfirmDelete} disabled={isProcessingDelete}>
                    {isProcessingDelete ? 'Deleting…' : 'Delete worktree'}
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
                Never ask
            </button>
            <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={closeDeleteDialog} disabled={isProcessingDelete}>
                    Cancel
                </Button>
                <Button variant="destructive" onClick={handleConfirmDelete} disabled={isProcessingDelete}>
                    {isProcessingDelete
                        ? 'Deleting…'
                        : deleteDialog?.sessions.length === 1
                            ? 'Delete session'
                            : 'Delete sessions'}
                </Button>
            </div>
        </div>
    );

    const deleteDialogTitle = isWorktreeDelete
        ? 'Delete worktree'
        : deleteDialog?.sessions.length === 1
            ? 'Delete session'
            : 'Delete sessions';

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
