import React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  tracking?: string;
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
  onSetUpstream?: (branch: string, remote: string, upstreamBranch: string) => Promise<void>;
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

const getRemoteBranchDisplayName = (branch: string): string => {
  return branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch;
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
  onSetUpstream,
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
  const [menuBranch, setMenuBranch] = React.useState<string | null>(null);
  const [menuPosition, setMenuPosition] = React.useState<{ x: number; y: number } | null>(null);
  const [renameBranch, setRenameBranch] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [isRenaming, setIsRenaming] = React.useState(false);
  const [deleteBranch, setDeleteBranch] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [upstreamBranch, setUpstreamBranch] = React.useState<string | null>(null);
  const [upstreamValue, setUpstreamValue] = React.useState('');
  const [upstreamSearch, setUpstreamSearch] = React.useState('');
  const [upstreamDropdownOpen, setUpstreamDropdownOpen] = React.useState(false);
  const [isSettingUpstream, setIsSettingUpstream] = React.useState(false);
  const createInputRef = React.useRef<HTMLInputElement>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const upstreamSearchInputRef = React.useRef<HTMLInputElement>(null);
  const upstreamDropdownRef = React.useRef<HTMLDivElement>(null);
  const contextMenuRef = React.useRef<HTMLDivElement>(null);
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = React.useRef(false);

  const stopDropdownTypeahead = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  const hasMultipleRemotes = remotes.length > 1;
  const canManageBranches = Boolean(onRename || onDelete || onSetUpstream);

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

  const upstreamOptions = React.useMemo(() => {
    const values = new Set(remoteBranches);
    if (upstreamBranch) {
      const tracking = branchInfo?.[upstreamBranch]?.tracking;
      if (tracking) {
        values.add(tracking);
      }
    }
    return Array.from(values);
  }, [branchInfo, remoteBranches, upstreamBranch]);

  const filteredUpstreamOptions = React.useMemo(() => {
    const term = upstreamSearch.trim().toLowerCase();
    if (!term) return upstreamOptions;
    return upstreamOptions.filter((branch) => branch.toLowerCase().includes(term));
  }, [upstreamOptions, upstreamSearch]);

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

  const clearLongPressTimer = React.useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const openBranchMenu = React.useCallback((branch: string, position: { x: number; y: number }) => {
    if (!canManageBranches) return;
    setMenuBranch(branch);
    setMenuPosition(position);
  }, [canManageBranches]);

  const startLongPress = React.useCallback((event: React.PointerEvent, branch: string) => {
    if (event.pointerType !== 'touch' || !canManageBranches) return;
    const target = event.currentTarget;
    clearLongPressTimer();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      const rect = target.getBoundingClientRect();
      longPressTriggeredRef.current = true;
      openBranchMenu(branch, { x: rect.left, y: rect.bottom + 4 });
    }, 550);
  }, [canManageBranches, clearLongPressTimer, openBranchMenu]);

  const handleBranchClickCapture = React.useCallback((event: React.MouseEvent) => {
    if (!longPressTriggeredRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    longPressTriggeredRef.current = false;
  }, []);

  const closeBranchMenu = React.useCallback(() => {
    setMenuBranch(null);
    setMenuPosition(null);
  }, []);

  const handleOpenRename = (branch: string) => {
    setRenameBranch(branch);
    setRenameValue(branch);
    closeBranchMenu();
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
    closeBranchMenu();
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

  const handleOpenUpstream = (branch: string) => {
    setUpstreamBranch(branch);
    setUpstreamValue(branchInfo?.[branch]?.tracking || remoteBranches[0] || '');
    setUpstreamSearch('');
    closeBranchMenu();
    setIsOpen(false);
  };

  const handleConfirmUpstream = async () => {
    if (!upstreamBranch || !onSetUpstream || !upstreamValue.trim() || isSettingUpstream) return;
    const normalized = upstreamValue.trim().replace(/^remotes\//, '');
    const slashIndex = normalized.indexOf('/');
    const remote = slashIndex > 0 ? normalized.slice(0, slashIndex) : remotes[0]?.name || 'origin';
    const targetBranch = slashIndex > 0 ? normalized.slice(slashIndex + 1) : normalized;
    if (!remote || !targetBranch) return;
    setIsSettingUpstream(true);
    try {
      await onSetUpstream(upstreamBranch, remote, targetBranch);
      setUpstreamBranch(null);
      setUpstreamValue('');
      setUpstreamSearch('');
      setUpstreamDropdownOpen(false);
    } finally {
      setIsSettingUpstream(false);
    }
  };

  const handleToggleUpstreamDropdown = () => {
    if (upstreamOptions.length === 0 || isSettingUpstream) return;
    setUpstreamDropdownOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setTimeout(() => upstreamSearchInputRef.current?.focus(), 0);
      }
      return nextOpen;
    });
  };

  const handleSelectUpstream = (branch: string) => {
    setUpstreamValue(branch);
    setUpstreamSearch('');
    setUpstreamDropdownOpen(false);
  };

  React.useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      setNewBranchName('');
      closeBranchMenu();
    }
  }, [closeBranchMenu, isOpen]);

  React.useEffect(() => {
    if (!menuBranch) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && contextMenuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-branch-menu-trigger]')) return;
      closeBranchMenu();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [closeBranchMenu, menuBranch]);

  React.useEffect(() => {
    if (!upstreamDropdownOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && upstreamDropdownRef.current?.contains(target)) return;
      setUpstreamDropdownOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [upstreamDropdownOpen]);

  React.useEffect(() => {
    if (!upstreamBranch) {
      setUpstreamSearch('');
      setUpstreamDropdownOpen(false);
    }
  }, [upstreamBranch]);

  React.useEffect(() => {
    if (!menuBranch) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeBranchMenu();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeBranchMenu, menuBranch]);

  React.useEffect(() => {
    return () => clearLongPressTimer();
  }, [clearLongPressTimer]);

  const branchMenuStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!menuPosition) return undefined;
    return {
      left: Math.min(Math.max(8, menuPosition.x), Math.max(8, window.innerWidth - 264)),
      top: Math.min(Math.max(8, menuPosition.y), Math.max(8, window.innerHeight - 152)),
    };
  }, [menuPosition]);

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
                <CommandItem
                  key={`local-${branch}`}
                  className="group"
                  onSelect={() => handleCheckout(branch)}
                  onMouseDown={(event) => {
                    if (event.button !== 2) return;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onContextMenu={(event) => {
                    if (!canManageBranches) return;
                    event.preventDefault();
                    event.stopPropagation();
                    longPressTriggeredRef.current = true;
                    openBranchMenu(branch, { x: event.clientX, y: event.clientY });
                  }}
                  onPointerDown={(event) => startLongPress(event, branch)}
                  onPointerMove={clearLongPressTimer}
                  onPointerUp={(event) => {
                    clearLongPressTimer();
                    if (event.button !== 2) return;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onPointerCancel={clearLongPressTimer}
                  onClickCapture={handleBranchClickCapture}
                >
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-1 size-6 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        event.preventDefault();
                        event.stopPropagation();
                        if (menuBranch === branch) {
                          closeBranchMenu();
                          return;
                        }
                        openBranchMenu(branch, { x: rect.right - 208, y: rect.bottom + 4 });
                      }}
                      aria-label={t('gitView.branch.actionsAria', { branch })}
                      aria-haspopup="menu"
                      aria-expanded={menuBranch === branch}
                      data-branch-menu-trigger={branch}
                    >
                      <Icon name="more-2" className="size-3.5" />
                    </Button>
                  ) : null}
                </CommandItem>
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
                    <BranchNameMarquee name={getRemoteBranchDisplayName(branch)} />
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
    {menuBranch && menuPosition ? createPortal(
      <div
        ref={contextMenuRef}
        role="menu"
        className="fixed z-[60] w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-[var(--surface-elevated)] p-1 text-[var(--surface-elevated-foreground)] shadow-lg"
        style={branchMenuStyle}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {onRename ? (
          <Button variant="ghost" size="sm" className="w-full min-w-0 justify-start normal-case" role="menuitem" onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleOpenRename(menuBranch);
          }}>
            <Icon name="edit" className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{t('gitView.branch.actions.rename')}</span>
          </Button>
        ) : null}
        {onSetUpstream ? (
          <Button variant="ghost" size="sm" className="w-full min-w-0 justify-start normal-case" role="menuitem" onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleOpenUpstream(menuBranch);
          }}>
            <Icon name="git-branch" className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{t('gitView.branch.actions.changeUpstream')}</span>
          </Button>
        ) : null}
        {onDelete ? (
          <Button variant="ghost" size="sm" className="w-full min-w-0 justify-start normal-case text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20" role="menuitem" onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleOpenDelete(menuBranch);
          }} disabled={currentBranch === menuBranch}>
            <Icon name="delete-bin" className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{t('gitView.branch.actions.delete')}</span>
          </Button>
        ) : null}
      </div>,
      document.body
    ) : null}
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
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-transparent px-3 typography-ui-label outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
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
    <Dialog open={upstreamBranch !== null} onOpenChange={(open) => !isSettingUpstream && !open && setUpstreamBranch(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('gitView.branch.upstreamDialogTitle')}</DialogTitle>
          <DialogDescription>{t('gitView.branch.upstreamDialogDescription', { branch: upstreamBranch || '' })}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleConfirmUpstream();
          }}
        >
          <div ref={upstreamDropdownRef} className="relative">
            {upstreamDropdownOpen ? (
              <div className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border px-2 text-left">
                <Icon name="search" className="size-4 shrink-0 text-muted-foreground" />
                <input
                  ref={upstreamSearchInputRef}
                  value={upstreamSearch}
                  onChange={(event) => setUpstreamSearch(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setUpstreamDropdownOpen(false);
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      if (filteredUpstreamOptions[0]) {
                        handleSelectUpstream(filteredUpstreamOptions[0]);
                      }
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
                  placeholder={upstreamValue ? getRemoteBranchDisplayName(upstreamValue) : t('gitView.branch.upstreamSearchPlaceholder')}
                  role="combobox"
                  aria-expanded="true"
                />
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" className="h-9 w-full min-w-0 justify-start text-left normal-case" onClick={handleToggleUpstreamDropdown} disabled={upstreamOptions.length === 0 || isSettingUpstream} aria-expanded={upstreamDropdownOpen}>
                {upstreamValue ? (
                  <BranchNameMarquee name={getRemoteBranchDisplayName(upstreamValue)} />
                ) : (
                  <span className="min-w-0 truncate text-muted-foreground">{t('gitView.branch.upstreamPlaceholder')}</span>
                )}
                <Icon name="arrow-down-s" className="ml-auto size-4 shrink-0 opacity-50" />
              </Button>
            )}
            {upstreamDropdownOpen ? (
              <div className="mt-1 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-[var(--surface-elevated)] p-1 text-[var(--surface-elevated-foreground)] shadow-lg">
                <div className="max-h-32 overflow-y-auto">
                  {filteredUpstreamOptions.map((branch) => (
                    <Button key={branch} type="button" variant="ghost" size="sm" className="w-full min-w-0 justify-start text-left normal-case" title={branch} onClick={() => handleSelectUpstream(branch)}>
                      <BranchNameMarquee name={getRemoteBranchDisplayName(branch)} />
                      {branch === upstreamValue ? <Icon name="check" className="size-4 shrink-0" /> : null}
                    </Button>
                  ))}
                  {filteredUpstreamOptions.length === 0 ? (
                    <div className="px-2 py-3 text-center typography-meta text-muted-foreground">
                      {t('gitView.branch.noUpstreamBranches')}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" type="button" onClick={() => setUpstreamBranch(null)} disabled={isSettingUpstream}>
              {t('gitView.common.cancel')}
            </Button>
            <Button size="sm" type="submit" disabled={!upstreamValue.trim() || isSettingUpstream}>
              {isSettingUpstream ? t('gitView.branch.upstreamSaving') : t('gitView.branch.upstreamConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
};
