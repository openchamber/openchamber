import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { GitRemote } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

interface BranchInfo {
  ahead?: number;
  behind?: number;
}

interface BranchSelectorProps {
  currentBranch: string | null | undefined;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, BranchInfo> | undefined;
  onCheckout: (branch: string) => void;
  onCreate: (name: string, remote?: GitRemote) => Promise<void>;
  onRename?: (oldName: string, newName: string) => Promise<void>;
  onDelete?: (branch: string) => Promise<void>;
  remotes?: GitRemote[];
  disabled?: boolean;
}

const BranchNameMarquee = ({ name }: { name: string }) => {
  const containerRef = React.useRef<HTMLSpanElement>(null);
  const textRef = React.useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;
    const updateOverflow = () => setIsOverflowing(text.scrollWidth > container.clientWidth + 1);
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(container);
    observer.observe(text);
    return () => observer.disconnect();
  }, [name]);

  return (
    <span ref={containerRef} className="min-w-0 flex-1 overflow-hidden text-left">
      {isOverflowing ? (
        <span className="open-file-name-marquee-track">
          <span ref={textRef} className="open-file-name-marquee-item">{name}</span>
          <span className="open-file-name-marquee-item" aria-hidden="true">{name}</span>
        </span>
      ) : (
        <span ref={textRef} className="block truncate">{name}</span>
      )}
    </span>
  );
};

const sanitizeBranchNameInput = (value: string): string => {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/\/-+/g, '/')
    .replace(/-+\//g, '/')
    .replace(/^[-/]+/, '')
    .replace(/[-/]+$/, '');
};

const getRemoteBranchDisplayName = (branch: string, remoteNames?: string[]): string => {
  const normalized = branch.replace(/^remotes\//, '');
  if (remoteNames) {
    for (const name of remoteNames) {
      if (normalized.startsWith(`${name}/`)) {
        return normalized.slice(name.length + 1);
      }
    }
    return normalized;
  }
  const slashIndex = normalized.indexOf('/');
  return slashIndex > 0 ? normalized.slice(slashIndex + 1) : normalized;
};

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  currentBranch,
  localBranches,
  remoteBranches,
  branchInfo,
  onCheckout,
  onCreate,
  onRename,
  onDelete,
  remotes = [],
  disabled = false,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [showCreate, setShowCreate] = React.useState(false);
  const [showRemoteSelect, setShowRemoteSelect] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const [contextMenuBranch, setContextMenuBranch] = React.useState<string | null>(null);
  const [actionMenuBranch, setActionMenuBranch] = React.useState<string | null>(null);
  const [renameBranch, setRenameBranch] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [isRenaming, setIsRenaming] = React.useState(false);
  const [deleteBranch, setDeleteBranch] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const createInputRef = React.useRef<HTMLInputElement>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);

  const stopDropdownTypeahead = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  const hasMultipleRemotes = remotes.length > 1;
  const canManageBranches = Boolean(onRename || onDelete);
  const remoteNames = React.useMemo(() => remotes.map((remote) => remote.name), [remotes]);

  const sanitizedNewBranch = React.useMemo(
    () => sanitizeBranchNameInput(newBranchName),
    [newBranchName]
  );

  const sanitizedRenameBranch = React.useMemo(
    () => sanitizeBranchNameInput(renameValue),
    [renameValue]
  );

  const filteredLocal = React.useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return localBranches;
    return localBranches.filter((b) => b.toLowerCase().includes(term));
  }, [search, localBranches]);

  const filteredRemote = React.useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return remoteBranches;
    return remoteBranches.filter((b) => b.toLowerCase().includes(term));
  }, [search, remoteBranches]);

  const handleCheckout = (branch: string) => {
    if (branch === currentBranch) {
      setIsOpen(false);
      return;
    }
    onCheckout(branch);
    setIsOpen(false);
    setSearch('');
  };

  const handleShowCreate = () => {
    setShowCreate(true);
    setTimeout(() => createInputRef.current?.focus(), 50);
  };

  const handleCreate = async () => {
    if (!sanitizedNewBranch || isCreating) return;

    // If multiple remotes, show remote selection first
    if (hasMultipleRemotes) {
      setShowRemoteSelect(true);
      return;
    }

    // Single or no remote - proceed directly
    setIsCreating(true);
    try {
      await onCreate(sanitizedNewBranch, remotes[0]);
      setNewBranchName('');
      setShowCreate(false);
      setIsOpen(false);
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelectRemote = async (remote: GitRemote) => {
    if (!sanitizedNewBranch || isCreating) return;
    setIsCreating(true);
    try {
      await onCreate(sanitizedNewBranch, remote);
      setNewBranchName('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      setIsOpen(false);
    } finally {
      setIsCreating(false);
    }
  };

  const handleBackFromRemoteSelect = () => {
    setShowRemoteSelect(false);
  };

  const handleCancelCreate = () => {
    setNewBranchName('');
    setShowCreate(false);
    setShowRemoteSelect(false);
  };

  const closeBranchMenus = React.useCallback(() => {
    setContextMenuBranch(null);
    setActionMenuBranch(null);
  }, []);

  const handleOpenRename = (branch: string) => {
    setRenameBranch(branch);
    setRenameValue(branch);
    closeBranchMenus();
    setIsOpen(false);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const handleConfirmRename = async () => {
    if (!renameBranch || !onRename || !sanitizedRenameBranch || isRenaming) return;
    if (sanitizedRenameBranch === renameBranch) {
      setRenameBranch(null);
      return;
    }
    setIsRenaming(true);
    try {
      await onRename(renameBranch, sanitizedRenameBranch);
      setRenameBranch(null);
      setRenameValue('');
    } finally {
      setIsRenaming(false);
    }
  };

  const handleOpenDelete = (branch: string) => {
    setDeleteBranch(branch);
    closeBranchMenus();
    setIsOpen(false);
  };

  const handleConfirmDelete = async () => {
    if (!deleteBranch || !onDelete || isDeleting) return;
    setIsDeleting(true);
    try {
      await onDelete(deleteBranch);
      setDeleteBranch(null);
    } finally {
      setIsDeleting(false);
    }
  };

  React.useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      setNewBranchName('');
      closeBranchMenus();
    }
  }, [closeBranchMenus, isOpen]);

  const renderBranchActions = (branch: string, Item: React.ElementType) => {
    const ActionItem = Item;

    return (
      <>
        {onRename ? (
          <ActionItem onClick={(event: React.MouseEvent) => {
            event.stopPropagation();
            handleOpenRename(branch);
          }}>
            <Icon name="edit" className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{t('gitView.branch.actions.rename')}</span>
          </ActionItem>
        ) : null}
        {onDelete ? (
          <ActionItem
            className="text-destructive focus:text-destructive"
            disabled={currentBranch === branch}
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              handleOpenDelete(branch);
            }}
          >
            <Icon name="delete-bin" className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{t('gitView.branch.actions.delete')}</span>
          </ActionItem>
        ) : null}
      </>
    );
  };

  return (
    <>
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 min-w-0 max-w-full justify-start gap-1.5 px-2 py-1"
              disabled={disabled}
            >
              <Icon name="git-branch" className="size-4 text-primary" />
              <span className="min-w-0 truncate font-medium text-left">
                {currentBranch || t('gitView.branch.detachedHead')}
              </span>
              <Icon name="arrow-down-s" className="size-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>
          {t('gitView.branch.currentBranchTooltip')}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="w-[calc(100vw-2rem)] p-0 max-h-[60vh] flex flex-col sm:w-72">
        <Command className="h-full min-h-0">
          <CommandInput
            placeholder={t('gitView.branch.searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
            onKeyDown={stopDropdownTypeahead}
          />
          <CommandList
            scrollbarClassName="overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero"
            disableHorizontal
          >
            <CommandEmpty>{t('gitView.branch.empty')}</CommandEmpty>

            <CommandGroup>
              {showRemoteSelect ? (
                // Remote selection step
                <div className="px-2 py-1.5">
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      type="button"
                      onClick={handleBackFromRemoteSelect}
                      disabled={isCreating}
                      className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <Icon name="arrow-left" className="size-4" />
                    </button>
                    <span className="typography-meta text-muted-foreground">
                      {t('gitView.branch.pushToPrefix')} <span className="text-foreground font-medium">{sanitizedNewBranch}</span> {t('gitView.branch.pushToSuffix')}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {remotes.map((remote) => (
                      <button
                        key={remote.name}
                        type="button"
                        onClick={() => handleSelectRemote(remote)}
                        disabled={isCreating}
                        className="flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-md text-left hover:bg-accent disabled:opacity-50"
                      >
                        <span className="typography-ui-label text-foreground">
                          {isCreating ? (
                            <Icon name="loader-4" className="inline size-3 mr-1.5 animate-spin" />
                          ) : null}
                          {remote.name}
                        </span>
                        <span className="typography-micro text-muted-foreground truncate max-w-full">
                          {remote.pushUrl}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : !showCreate ? (
                <CommandItem onSelect={handleShowCreate}>
                  <Icon name="add" className="size-4" />
                  <span>{t('gitView.branch.create')}</span>
                </CommandItem>
              ) : (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg">
                  <input
                    ref={createInputRef}
                    placeholder={t('gitView.branch.newBranchPlaceholder')}
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      stopDropdownTypeahead(e);
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCreate();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        handleCancelCreate();
                      }
                    }}
                    className="flex-1 min-w-0 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!sanitizedNewBranch || isCreating}
                    className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {isCreating ? (
                      <Icon name="loader-4" className="size-4 animate-spin" />
                    ) : (
                      <Icon name="add" className="size-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelCreate}
                    disabled={isCreating}
                    className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </div>
              )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('gitView.branch.localBranches')}>
              {filteredLocal.map((branch) => (
                <ContextMenu key={`local-${branch}`} open={contextMenuBranch === branch} onOpenChange={(open) => setContextMenuBranch(open ? branch : null)}>
                  <ContextMenuTrigger render={<div className="contents" />}>
                    <CommandItem className="group" onSelect={() => handleCheckout(branch)}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-2 typography-ui-label text-foreground">
                          {currentBranch === branch && (
                            <span className="typography-micro shrink-0 text-primary">{t('gitView.branch.currentBadge')}</span>
                          )}
                          <BranchNameMarquee name={branch} />
                        </span>
                        {(branchInfo?.[branch]?.ahead || branchInfo?.[branch]?.behind) && (
                          <span className="typography-micro text-muted-foreground">
                            {branchInfo[branch].ahead || 0} ahead ·{' '}
                            {branchInfo[branch].behind || 0} behind
                          </span>
                        )}
                      </span>
                      {canManageBranches ? (
                        <DropdownMenu open={actionMenuBranch === branch} onOpenChange={(open) => setActionMenuBranch(open ? branch : null)}>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="ml-1 size-6 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                              onMouseDown={(event) => {
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              aria-label={t('gitView.branch.actionsAria', { branch })}
                            >
                              <Icon name="more-2" className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            {renderBranchActions(branch, DropdownMenuItem)}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </CommandItem>
                  </ContextMenuTrigger>
                  {canManageBranches ? (
                    <ContextMenuContent className="w-56">
                      {renderBranchActions(branch, ContextMenuItem)}
                    </ContextMenuContent>
                  ) : null}
                </ContextMenu>
              ))}
              {filteredLocal.length === 0 && (
                <CommandItem disabled className="justify-center">
                  <span className="typography-meta text-muted-foreground">
                    {t('gitView.branch.noLocalBranches')}
                  </span>
                </CommandItem>
              )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('gitView.branch.remoteBranches')}>
              {filteredRemote.map((branch) => (
                <CommandItem
                  key={`remote-${branch}`}
                  onSelect={() => handleCheckout(branch)}
                  className="justify-start text-left"
                >
                  <span className="flex min-w-0 flex-1 typography-ui-label text-foreground">
                    <BranchNameMarquee name={getRemoteBranchDisplayName(branch, remoteNames)} />
                  </span>
                </CommandItem>
              ))}
              {filteredRemote.length === 0 && (
                <CommandItem disabled className="justify-center">
                  <span className="typography-meta text-muted-foreground">
                    {t('gitView.branch.noRemoteBranches')}
                  </span>
                </CommandItem>
              )}
            </CommandGroup>

          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={renameBranch !== null} onOpenChange={(open) => !isRenaming && !open && setRenameBranch(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('gitView.branch.renameDialogTitle')}</DialogTitle>
          <DialogDescription>{t('gitView.branch.renameDialogDescription', { branch: renameBranch || '' })}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleConfirmRename();
          }}
        >
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            className="typography-ui-label"
            placeholder={t('gitView.branch.namePlaceholder')}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" type="button" onClick={() => setRenameBranch(null)} disabled={isRenaming}>
              {t('gitView.common.cancel')}
            </Button>
            <Button size="sm" type="submit" disabled={!sanitizedRenameBranch || sanitizedRenameBranch === renameBranch || isRenaming}>
              {isRenaming ? t('gitView.branch.renameSaving') : t('gitView.branch.renameConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={deleteBranch !== null} onOpenChange={(open) => !isDeleting && !open && setDeleteBranch(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('gitView.branch.deleteDialogTitle')}</DialogTitle>
          <DialogDescription>{t('gitView.branch.deleteDialogDescription', { branch: deleteBranch || '' })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setDeleteBranch(null)} disabled={isDeleting}>
            {t('gitView.common.cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void handleConfirmDelete()} disabled={isDeleting}>
            {isDeleting ? t('gitView.branch.deleting') : t('gitView.branch.deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
};
