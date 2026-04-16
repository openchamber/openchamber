import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import {
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiGitBranchLine,
  RiLoader4Line,
  RiPencilLine,
  RiSearchLine,
  RiSplitCellsHorizontal,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { deleteGitBranch, getGitBranches, git, renameBranch } from '@/lib/gitApi';
import type { GitBranch, GitWorktreeInfo } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { getWorktreeSetupCommands } from '@/lib/openchamberConfig';
import { sessionEvents } from '@/lib/sessionEvents';
import { useSessions } from '@/sync/sync-context';
import { m } from '@/lib/i18n/messages';

export interface BranchPickerProject {
  id: string;
  path: string;
  normalizedPath: string;
  label?: string;
}

interface BranchPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: BranchPickerProject | null;
}

const displayProjectName = (project: BranchPickerProject): string =>
  project.label || project.normalizedPath.split('/').pop() || project.normalizedPath;

const normalizeBranchName = (value: string | null | undefined): string => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/^remotes\//, '');
};

const normalizePath = (value: string | null | undefined): string => {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) {
    return '';
  }
  if (raw === '/') {
    return '/';
  }
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
};

export function BranchPickerDialog({ open, onOpenChange, project }: BranchPickerDialogProps) {
  const sessions = useSessions();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [branches, setBranches] = React.useState<GitBranch | null>(null);
  const [worktrees, setWorktrees] = React.useState<GitWorktreeInfo[]>([]);
  const [rootBranchName, setRootBranchName] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [creatingWorktreeBranch, setCreatingWorktreeBranch] = React.useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<string | null>(null);
  const [forceDeleteBranch, setForceDeleteBranch] = React.useState<string | null>(null);
  const [editingBranch, setEditingBranch] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const [renamingBranchKey, setRenamingBranchKey] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      const [b, w, rootBranch] = await Promise.all([
        getGitBranches(project.path),
        git.worktree.list(project.path),
        getRootBranch(project.path).catch(() => null),
      ]);
      setBranches(b);
      setWorktrees(w);
      setRootBranchName(rootBranch);
    } catch (err) {
      setError(err instanceof Error ? err.message : m.bpFailedToLoad());
      setBranches(null);
      setWorktrees([]);
      setRootBranchName(null);
    } finally {
      setLoading(false);
    }
  }, [project]);

  React.useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setConfirmingDelete(null);
      setForceDeleteBranch(null);
      setEditingBranch(null);
      setEditValue('');
      setRenamingBranchKey(null);
      setCreatingWorktreeBranch(null);
      return;
    }
    void refresh();
  }, [open, refresh]);

  const filterBranches = (list: string[], query: string): string[] => {
    if (!query.trim()) return list;
    const lower = query.toLowerCase();
    return list.filter((b) => b.toLowerCase().includes(lower));
  };

  const beginRename = React.useCallback((branchName: string) => {
    setEditingBranch(branchName);
    setEditValue(branchName);
  }, []);

  const cancelRename = React.useCallback(() => {
    setEditingBranch(null);
    setEditValue('');
    setRenamingBranchKey(null);
  }, []);

  const cancelDelete = React.useCallback(() => {
    setConfirmingDelete(null);
    setForceDeleteBranch(null);
  }, []);

  const commitRename = React.useCallback(async (oldName: string) => {
    if (!project) return;
    const newName = editValue.trim();
    if (!newName || newName === oldName) {
      cancelRename();
      return;
    }

    setRenamingBranchKey(oldName);
    try {
      const result = await renameBranch(project.path, oldName, newName);
      if (!result?.success) {
        throw new Error('Rename rejected');
      }
      await refresh();
      cancelRename();
      toast.success(m.bpBranchRenamed(), { description: `${oldName} -> ${newName}` });
    } catch (err) {
      toast.error(m.bpFailedToRenameBranch(), {
        description: err instanceof Error ? err.message : m.bpRenameFailed(),
      });
      setRenamingBranchKey(null);
    }
  }, [project, editValue, refresh, cancelRename]);

  const handleDeleteBranch = React.useCallback(async (branchName: string) => {
    if (!project) return;
    setDeletingBranch(branchName);
    try {
      const force = forceDeleteBranch === branchName;
      const result = await deleteGitBranch(project.path, { branch: branchName, force });
      if (!result?.success) {
        throw new Error('Delete rejected');
      }
      await refresh();
      toast.success(m.bpBranchDeleted(), { description: branchName });
      setConfirmingDelete(null);
      setForceDeleteBranch(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : m.bpDeleteFailed();
      // If branch isn't merged, prompt for force delete on next confirm.
      if (/not fully merged/i.test(message) && forceDeleteBranch !== branchName) {
        setForceDeleteBranch(branchName);
        toast.error(m.bpBranchNotMerged(), {
          description: m.bpConfirmAgainToForceDelete(),
        });
      } else {
        toast.error(m.bpFailedToDeleteBranch(), { description: message });
      }
    } finally {
      setDeletingBranch(null);
    }
  }, [project, refresh, forceDeleteBranch]);

  const handleCreateWorktreeForBranch = React.useCallback(async (branchName: string) => {
    if (!project) {
      return;
    }

    setCreatingWorktreeBranch(branchName);
    try {
      const setupCommands = await getWorktreeSetupCommands({
        id: project.id,
        path: project.path,
      });
      await createWorktreeWithDefaults(
        {
          id: project.id,
          path: project.path,
        },
        {
          preferredName: branchName,
          mode: 'existing',
          existingBranch: branchName,
          branchName,
          worktreeName: branchName,
          setupCommands,
        }
      );
      await refresh();
      toast.success(m.bpWorktreeCreated(), { description: branchName });
    } catch (err) {
      toast.error(m.bpFailedToCreateWorktree(), {
        description: err instanceof Error ? err.message : m.bpCreateWorktreeFailed(),
      });
    } finally {
      setCreatingWorktreeBranch(null);
    }
  }, [project, refresh]);

  const handleRemoveWorktree = React.useCallback((worktree: GitWorktreeInfo | null) => {
    if (!project || !worktree) {
      return;
    }

    const normalizedWorktreePath = normalizePath(worktree.path);
    const directSessions = sessions.filter((session) => {
      const sessionPath = normalizePath(session.directory ?? null);
      return Boolean(sessionPath) && sessionPath === normalizedWorktreePath;
    });
    const directSessionIds = new Set(directSessions.map((session) => session.id));

    const findSubsessions = (parentIds: Set<string>): typeof sessions => {
      const subsessions = sessions.filter((session) => {
        const parentID = (session as { parentID?: string | null }).parentID;
        if (!parentID) {
          return false;
        }
        return parentIds.has(parentID);
      });
      if (subsessions.length === 0) {
        return [];
      }
      const subsessionIds = new Set(subsessions.map((session) => session.id));
      return [...subsessions, ...findSubsessions(subsessionIds)];
    };

    const allSubsessions = findSubsessions(directSessionIds);
    const seenIds = new Set<string>();
    const allSessions = [...directSessions, ...allSubsessions].filter((session) => {
      if (seenIds.has(session.id)) {
        return false;
      }
      seenIds.add(session.id);
      return true;
    });

    const normalizedBranch = normalizeBranchName(worktree.branch);
    const worktreeMetadata: WorktreeMetadata = {
      source: 'sdk',
      name: worktree.name,
      path: worktree.path,
      projectDirectory: project.path,
      branch: normalizedBranch,
      label: normalizedBranch || worktree.name,
    };

    sessionEvents.requestDelete({
      sessions: allSessions,
      mode: 'worktree',
      worktree: worktreeMetadata,
    });
  }, [project, sessions]);

  const worktreeByBranch = new Map<string, GitWorktreeInfo>();
  for (const worktree of worktrees) {
    const branchName = normalizeBranchName(worktree.branch);
    if (branchName && !worktreeByBranch.has(branchName)) {
      worktreeByBranch.set(branchName, worktree);
    }
  }

  const normalizedRootBranch = normalizeBranchName(rootBranchName);
  const allBranches = branches?.all || [];
  const filteredBranches = filterBranches(allBranches, searchQuery);
  const localBranches = filteredBranches.filter((b) => !b.startsWith('remotes/'));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col overflow-hidden gap-3">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RiGitBranchLine className="h-5 w-5" />
            {m.bpManageBranches()}
          </DialogTitle>
          <DialogDescription>
            {project ? m.bpLocalBranchesForProject({ project: displayProjectName(project) }) : m.bpSelectAProject()}
          </DialogDescription>
        </DialogHeader>

        <div className="relative flex-shrink-0">
          <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={m.bpSearchBranches()}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-1">
            {!project ? (
              <div className="text-center py-8 text-muted-foreground">{m.bpNoProjectSelected()}</div>
            ) : loading ? (
              <div className="px-2 py-2 text-muted-foreground text-sm">{m.bpLoadingBranches()}</div>
            ) : error ? (
              <div className="px-2 py-2 text-destructive text-sm">{error}</div>
            ) : localBranches.length === 0 ? (
              <div className="px-2 py-2 text-muted-foreground text-sm">
                {searchQuery ? m.bpNoMatchingBranches() : m.bpNoBranchesFound()}
              </div>
            ) : (
              localBranches.map((branchName) => {
                const details = branches?.branches[branchName];
                const normalizedBranchName = normalizeBranchName(branchName);
                const isCurrent = Boolean(details?.current);
                const isDeleting = deletingBranch === branchName;
                const isRenaming = renamingBranchKey === branchName;
                const attachedWorktree = worktreeByBranch.get(normalizedBranchName) ?? null;
                const hasAttachedWorktree = Boolean(attachedWorktree);
                const isProjectRootBranch = Boolean(
                  normalizedBranchName &&
                  normalizedRootBranch &&
                  normalizedBranchName === normalizedRootBranch
                );
                const isEditing = editingBranch === branchName;
                const isConfirming = confirmingDelete === branchName;
                const isForceDelete = forceDeleteBranch === branchName;
                const isCreatingWorktree = creatingWorktreeBranch === branchName;

                const disableCreateWorktree = Boolean(
                  hasAttachedWorktree || isCreatingWorktree || isDeleting || isRenaming || isEditing
                );
                const disableDelete = Boolean(
                  isCurrent || isDeleting || isRenaming || isEditing || isCreatingWorktree || isProjectRootBranch
                );
                const disableRename = Boolean(
                  isDeleting || isRenaming || isEditing || isCreatingWorktree || isProjectRootBranch
                );
                const disableWorktreeDelete = Boolean(
                  isDeleting || isRenaming || isEditing || isCreatingWorktree || isProjectRootBranch || !attachedWorktree
                );

                return (
                  <div
                    key={branchName}
                    className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-interactive-hover/30 rounded-md overflow-hidden"
                  >
                    <RiGitBranchLine className="h-4 w-4 text-muted-foreground flex-shrink-0" />

                    <div className="flex-1 min-w-0 overflow-hidden">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {isEditing ? (
                          <form
                            className="flex w-full items-center min-w-0"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void commitRename(branchName);
                            }}
                          >
                             <input
                              value={editValue}
                              onChange={(event) => setEditValue(event.target.value)}
                              className="flex-1 min-w-0 h-5 bg-transparent text-sm leading-none outline-none placeholder:text-muted-foreground"
                              autoFocus
                              placeholder={m.bpRenameBranch()}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  cancelRename();
                                }
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  void commitRename(branchName);
                                }
                              }}
                            />
                          </form>
                        ) : (
                          <span className={cn('text-sm truncate', isCurrent && 'font-medium text-primary')}>
                            {branchName}
                          </span>
                        )}

                        {isCurrent && (
                          <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded flex-shrink-0 whitespace-nowrap">
                            HEAD
                          </span>
                        )}

                        {hasAttachedWorktree && !isEditing && (
                          <span className="text-xs bg-muted/40 text-muted-foreground px-1.5 py-0.5 rounded flex-shrink-0 whitespace-nowrap">
                            {m.bpWorktree()}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {details?.commit ? (
                          <span className="font-mono">{details.commit.slice(0, 7)}</span>
                        ) : null}
                        {typeof details?.ahead === 'number' && details.ahead > 0 ? (
                          <span className="text-[color:var(--status-success)]">↑{details.ahead}</span>
                        ) : null}
                        {typeof details?.behind === 'number' && details.behind > 0 ? (
                          <span className="text-[color:var(--status-warning)]">↓{details.behind}</span>
                        ) : null}
                      </div>
                    </div>

                    {!isEditing && !isConfirming ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Tooltip delayDuration={700}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => void handleCreateWorktreeForBranch(branchName)}
                              disabled={disableCreateWorktree}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-interactive-hover/40 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                              aria-label={m.bpCreateWorktree()}
                            >
                              {isCreatingWorktree ? (
                                <RiLoader4Line className="h-4 w-4 animate-spin" />
                              ) : (
                                <RiSplitCellsHorizontal className="h-4 w-4" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            {hasAttachedWorktree ? m.bpWorktreeAlreadyExists() : m.bpCreateWorktree()}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip delayDuration={700}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => beginRename(branchName)}
                              disabled={disableRename}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-interactive-hover/40 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                              aria-label={m.bpRename()}
                            >
                              <RiPencilLine className="h-4 w-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            {isProjectRootBranch ? m.bpRenameDisabledForRootBranch() : m.bpRename()}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip delayDuration={700}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                if (hasAttachedWorktree) {
                                  handleRemoveWorktree(attachedWorktree);
                                  return;
                                }
                                setConfirmingDelete(branchName);
                              }}
                              disabled={hasAttachedWorktree ? disableWorktreeDelete : disableDelete}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                              aria-label={hasAttachedWorktree ? m.bpDeleteWorktree() : m.bpDelete()}
                            >
                              {isDeleting ? (
                                <RiLoader4Line className="h-4 w-4 animate-spin" />
                              ) : (
                                <RiDeleteBinLine className="h-4 w-4" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            {hasAttachedWorktree
                              ? isProjectRootBranch
                                ? m.bpDeleteWorktreeRootBranchProtected()
                                : m.bpDeleteWorktree()
                              : isCurrent
                                ? m.bpDeleteCurrentBranch()
                                : isProjectRootBranch
                                  ? m.bpDeleteDisabledForRootBranch()
                                  : m.bpDelete()}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    ) : null}

                    {isEditing ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => void commitRename(branchName)}
                          disabled={isRenaming}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-interactive-hover/40 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                          aria-label={m.bpConfirmRename()}
                        >
                          {isRenaming ? (
                            <RiLoader4Line className="h-4 w-4 animate-spin" />
                          ) : (
                            <RiCheckLine className="h-4 w-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={cancelRename}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-interactive-hover/40 text-muted-foreground hover:text-foreground transition-colors"
                          aria-label={m.bpCancelRename()}
                        >
                          <RiCloseLine className="h-4 w-4" />
                        </button>
                      </div>
                    ) : null}

                    {!isEditing && isConfirming && !hasAttachedWorktree ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className={cn(
                          'text-xs mr-1',
                          isForceDelete ? 'text-destructive' : 'text-muted-foreground'
                        )}>
                          {isForceDelete ? m.bpForceDeleteQuestion() : m.bpDeleteQuestion()}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleDeleteBranch(branchName)}
                          disabled={isDeleting}
                          className={cn(
                            'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-50',
                            isForceDelete
                              ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
                              : 'hover:bg-destructive/10 text-muted-foreground hover:text-destructive'
                          )}
                          aria-label={m.bpConfirmDelete()}
                        >
                          {isDeleting ? (
                            <RiLoader4Line className="h-4 w-4 animate-spin" />
                          ) : (
                            <RiCheckLine className="h-4 w-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={cancelDelete}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-interactive-hover/40 text-muted-foreground hover:text-foreground transition-colors"
                          aria-label={m.bpCancelDelete()}
                        >
                          <RiCloseLine className="h-4 w-4" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
