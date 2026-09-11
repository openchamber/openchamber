import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import type { GitRemote } from '@/lib/api/types';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { getGitUnpushedBranchCounts } from '@/lib/gitApi';
import { getRecentBranches, rememberRecentBranch } from './recentBranches';

interface BranchInfo {
  ahead?: number;
  behind?: number;
}

interface BranchSelectorProps {
  currentBranch: string | null | undefined;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, BranchInfo> | undefined;
  currentBranchAhead?: number;
  onCheckout: (branch: string) => void;
  onCreate: (name: string, remote?: GitRemote) => Promise<void>;
  remotes?: GitRemote[];
  disabled?: boolean;
  directory: string;
  /**
   * Shown above the branch list while the working tree has uncommitted
   * changes: selecting a branch will not switch directly but opens the
   * commit-or-revert resolution instead.
   */
  switchBlockedNotice?: string | null;
}

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

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  currentBranch,
  localBranches,
  remoteBranches,
  branchInfo,
  currentBranchAhead = 0,
  onCheckout,
  onCreate,
  remotes = [],
  disabled = false,
  directory,
  switchBlockedNotice = null,
}) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [isOpen, setIsOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [showCreate, setShowCreate] = React.useState(false);
  const [showRemoteSelect, setShowRemoteSelect] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const [recentBranches, setRecentBranches] = React.useState<string[]>(() => getRecentBranches(directory));
  const [unpushedCounts, setUnpushedCounts] = React.useState<Record<string, number>>({});
  const createInputRef = React.useRef<HTMLInputElement>(null);

  const stopDropdownTypeahead = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  const hasMultipleRemotes = remotes.length > 1;

  const sanitizedNewBranch = React.useMemo(
    () => sanitizeBranchNameInput(newBranchName),
    [newBranchName]
  );

  const filteredLocal = React.useMemo(
    () => rankByQuery(localBranches, search, (branch) => [branch]),
    [search, localBranches]
  );

  const filteredRemote = React.useMemo(
    () => rankByQuery(remoteBranches, search, (branch) => [branch]),
    [search, remoteBranches]
  );

  const handleCheckout = (branch: string) => {
    if (branch === currentBranch) {
      setIsOpen(false);
      return;
    }
    setRecentBranches(rememberRecentBranch(directory, branch));
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

  React.useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      setNewBranchName('');
    }
  }, [isOpen]);

  React.useEffect(() => {
    if (!directory) return;
    setRecentBranches(currentBranch
      ? rememberRecentBranch(directory, currentBranch)
      : getRecentBranches(directory));
  }, [currentBranch, directory]);

  React.useEffect(() => {
    if (!isOpen) return;
    const branches = recentBranches.filter((branch) => localBranches.includes(branch)).slice(0, 5);
    if (branches.length === 0) return setUnpushedCounts({});
    let cancelled = false;
    getGitUnpushedBranchCounts(directory, branches)
      .then(({ counts }) => { if (!cancelled) setUnpushedCounts(counts); })
      .catch(() => { if (!cancelled) setUnpushedCounts({}); });
    return () => { cancelled = true; };
  }, [directory, isOpen, localBranches, recentBranches]);

  if (isMobile) {
    const recentLocalBranches = recentBranches.filter((branch) => localBranches.includes(branch));
    const renderBranch = (branch: string, remote = false) => {
      const ahead = unpushedCounts[branch] ?? (branch === currentBranch ? currentBranchAhead : 0);
      const aheadLabel = ahead === 1
        ? t('gitView.branch.unpushedSingle')
        : t('gitView.branch.unpushedPlural', { count: ahead });
      return (
        <button
          key={`${remote ? 'remote' : 'local'}-${branch}`}
          type="button"
          onClick={() => handleCheckout(branch)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left typography-ui-label hover:bg-interactive-hover"
        >
          <span className="min-w-0 flex-1 truncate">{branch}</span>
          {ahead > 0 ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 typography-micro text-muted-foreground"
              title={aheadLabel}
              aria-label={aheadLabel}
            >
              <Icon name="arrow-up" className="size-3" aria-hidden="true" />
              <span aria-hidden="true">{ahead}</span>
            </span>
          ) : null}
          {currentBranch === branch ? <Icon name="check" className="size-4 shrink-0 text-primary" /> : null}
        </button>
      );
    };

    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 min-w-0 max-w-full justify-start gap-1.5 px-2 py-1"
          disabled={disabled}
          onClick={() => setIsOpen(true)}
        >
          <Icon name="git-branch" className="size-4 text-primary" />
          <span className="min-w-0 truncate font-medium text-left">
            {currentBranch || t('gitView.branch.detachedHead')}
          </span>
          <Icon name="arrow-down-s" className="size-4 opacity-60" />
        </Button>

        <MobileOverlayPanel
          open={isOpen}
          title={t('gitView.branch.currentBranchTooltip')}
          onClose={() => setIsOpen(false)}
        >
          <div className="flex flex-col gap-2 px-3 pb-4 pt-1">
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('gitView.branch.searchPlaceholder')}
              className="h-9 w-full rounded-lg border border-border bg-transparent px-3 typography-meta outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary"
            />
            {switchBlockedNotice ? (
              <div className="flex items-start gap-2 px-2 py-1">
                <Icon name="alert" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-warning)]" aria-hidden="true" />
                <span className="typography-micro text-muted-foreground">{switchBlockedNotice}</span>
              </div>
            ) : null}
            {recentLocalBranches.length > 0 ? (
              <section>
                <p className="px-2 pb-1 pt-2 typography-meta text-muted-foreground">{t('gitView.branch.recentBranches')}</p>
                {recentLocalBranches.map((branch) => renderBranch(branch))}
              </section>
            ) : null}
            <section>
              <p className="px-2 pb-1 pt-2 typography-meta text-muted-foreground">{t('gitView.branch.localBranches')}</p>
              {filteredLocal.map((branch) => renderBranch(branch))}
            </section>
            <section>
              <p className="px-2 pb-1 pt-2 typography-meta text-muted-foreground">{t('gitView.branch.remoteBranches')}</p>
              {filteredRemote.map((branch) => renderBranch(branch, true))}
            </section>
          </div>
        </MobileOverlayPanel>
      </>
    );
  }

  return (
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

      <DropdownMenuContent align="start" className="w-72 p-0 max-h-[60vh] flex flex-col">
        {/* Filtering and ordering are owned by rankByQuery above; cmdk's own
            filter would re-filter and reorder the already-ranked rows. */}
        <Command className="h-full min-h-0" shouldFilter={false}>
          <CommandInput
            placeholder={t('gitView.branch.searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
            onKeyDown={stopDropdownTypeahead}
          />
          {switchBlockedNotice ? (
            <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2">
              <Icon name="alert" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-warning)]" aria-hidden="true" />
              <span className="typography-micro text-muted-foreground">{switchBlockedNotice}</span>
            </div>
          ) : null}
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

            {recentBranches.filter((branch) => localBranches.includes(branch)).length > 0 ? (
              <>
                <CommandGroup heading={t('gitView.branch.recentBranches')}>
                  {recentBranches.filter((branch) => localBranches.includes(branch)).map((branch) => (
                    <CommandItem key={`recent-${branch}`} onSelect={() => handleCheckout(branch)}>
                      <span className="flex flex-1 items-center gap-2 min-w-0">
                        <span className="typography-ui-label text-foreground truncate">{branch}</span>
                        {(() => {
                          const ahead = unpushedCounts[branch] ?? (branch === currentBranch ? currentBranchAhead : 0);
                          const aheadLabel = ahead === 1
                            ? t('gitView.branch.unpushedSingle')
                            : t('gitView.branch.unpushedPlural', { count: ahead });
                          return ahead > 0 ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 typography-micro text-muted-foreground"
                            title={aheadLabel}
                            aria-label={aheadLabel}
                          >
                            <Icon name="arrow-up" className="size-3" aria-hidden="true" />
                            <span aria-hidden="true">{ahead}</span>
                          </span>
                          ) : null;
                        })()}
                      </span>
                      {currentBranch === branch ? <span className="typography-micro text-primary">{t('gitView.branch.currentBadge')}</span> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}

            <CommandGroup heading={t('gitView.branch.localBranches')}>
              {filteredLocal.map((branch) => (
                <CommandItem
                  key={`local-${branch}`}
                  onSelect={() => handleCheckout(branch)}
                >
                  <span className="flex flex-1 flex-col">
                    <span className="typography-ui-label text-foreground">
                      {branch}
                    </span>
                    {(branchInfo?.[branch]?.ahead || branchInfo?.[branch]?.behind) && (
                      <span className="typography-micro text-muted-foreground">
                        {branchInfo[branch].ahead || 0} ahead ·{' '}
                        {branchInfo[branch].behind || 0} behind
                      </span>
                    )}
                  </span>
                  {currentBranch === branch && (
                    <span className="typography-micro text-primary">{t('gitView.branch.currentBadge')}</span>
                  )}
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
                >
                  <span className="typography-ui-label text-foreground">{branch}</span>
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
  );
};
