import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSearch, MobileSheetSection } from '@/components/ui/MobileSheetList';
import { useRemoteBranchSearch } from '@/hooks/useRemoteBranchSearch';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { rankBranchesForQuery } from '@/lib/worktrees/branchSearch';

export type PickedBranch = { value: string; label: string };

type BranchSection = { heading: string; branches: PickedBranch[] };

const REMOTE_FULL_RANK_LIMIT = 1000;
const REMOTE_RANK_CANDIDATE_LIMIT = 500;

const findScrollableAncestor = (start: HTMLElement | null): HTMLElement | null => {
  let node = start;
  while (node && node !== document.body) {
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
};

export function NewWorktreeBranchPicker({
  value,
  placeholder,
  title,
  localBranches,
  remoteBranches,
  searchRemoteBranches,
  isLoading,
  isMobile,
  disabled = false,
  onSelect,
}: {
  value: string;
  placeholder: string;
  title: string;
  localBranches: string[];
  remoteBranches: string[];
  searchRemoteBranches?: (query: string) => Promise<string[]>;
  isLoading: boolean;
  isMobile: boolean;
  disabled?: boolean;
  onSelect: (branch: PickedBranch) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const desktopContentRef = React.useRef<HTMLDivElement | null>(null);
  const mobileListRef = React.useRef<HTMLDivElement | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  const remoteSearch = useRemoteBranchSearch({
    enabled: open && remoteBranches.length === 0,
    query,
    search: searchRemoteBranches,
  });

  const knownRemotes = React.useMemo(() => {
    if (!searching || remoteBranches.length === 0) return [];
    if (remoteBranches.length <= REMOTE_FULL_RANK_LIMIT) return remoteBranches;
    const narrowed: string[] = [];
    for (const branch of remoteBranches) {
      if (!branch.toLowerCase().includes(normalizedQuery)) continue;
      narrowed.push(branch);
      if (narrowed.length >= REMOTE_RANK_CANDIDATE_LIMIT) break;
    }
    return narrowed;
  }, [searching, remoteBranches, normalizedQuery]);

  const matchingRemoteBranches = remoteBranches.length > 0 ? knownRemotes : remoteSearch.matches;

  const sections = React.useMemo((): BranchSection[] => {
    const ranked = rankBranchesForQuery({ localBranches, remoteBranches: matchingRemoteBranches, query });
    if (searching) {
      return ranked.matching.length > 0
        ? [{ heading: t('session.newWorktree.matchingBranches'), branches: ranked.matching.map(({ value: branch, label }) => ({ value: branch, label })) }]
        : [];
    }
    return ranked.otherLocal.length > 0
      ? [{ heading: t('session.newWorktree.localBranches'), branches: ranked.otherLocal.map((branch) => ({ value: branch, label: branch })) }]
      : [];
  }, [localBranches, matchingRemoteBranches, query, searching, t]);

  React.useEffect(() => {
    if (!open) return;
    if (isMobile) {
      const scroller = findScrollableAncestor(mobileListRef.current);
      if (scroller) scroller.scrollTop = 0;
      return;
    }
    const list = desktopContentRef.current?.querySelector<HTMLElement>('[data-slot="command-list"]');
    if (list) list.scrollTop = 0;
  }, [open, query, isMobile]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      remoteSearch.reset();
    }
  };
  const choose = (branch: PickedBranch) => {
    onSelect(branch);
    changeOpen(false);
  };

  const status = isLoading && !searching && localBranches.length === 0
    ? t('session.newWorktree.loadingBranches')
    : searching && sections.length === 0
      ? remoteSearch.failed
        ? t('branchPickerDialog.error.failedToLoad')
        : remoteSearch.isSearching
          ? t('session.newWorktree.loadingBranches')
          : t('session.newWorktree.noMatchingBranches')
      : !searching && localBranches.length === 0
        ? t('session.newWorktree.noBranchesFound')
        : null;
  const triggerLabel = (
    <span className={cn('truncate', value ? 'text-foreground' : 'text-muted-foreground')}>{value || placeholder}</span>
  );

  if (isMobile) {
    return (
      <>
        <Button variant="outline" size="sm" onClick={() => changeOpen(true)} disabled={disabled} className="h-8 w-full justify-between">
          {triggerLabel}
          <Icon name="git-branch" className="h-4 w-4 text-muted-foreground" />
        </Button>
        <MobileOverlayPanel
          open={open}
          title={title}
          onClose={() => changeOpen(false)}
          subheader={<MobileSheetSearch value={query} onChange={setQuery} placeholder={t('session.newWorktree.searchBranches')} />}
        >
          <div ref={mobileListRef}>
            {status ? (
              <div className="px-2 py-8 text-center typography-meta text-muted-foreground">{status}</div>
            ) : sections.map((section) => (
              <MobileSheetSection key={section.heading} title={section.heading}>
                {section.branches.map((branch) => (
                  <MobileSheetRow key={branch.value} selected={value === branch.value} onClick={() => choose(branch)}>
                    {branch.label}
                  </MobileSheetRow>
                ))}
              </MobileSheetSection>
            ))}
          </div>
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button type="button" disabled={disabled} className={cn(dropdownTriggerVariants({ size: 'default' }), 'w-full max-w-full disabled:cursor-not-allowed disabled:opacity-50')}>
          {triggerLabel}
          <Icon name="arrow-down-s" className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        portalToBody
        className="flex max-h-[min(var(--available-height),24rem)] w-[var(--anchor-width)] min-w-[16rem] flex-col overflow-hidden p-0"
        ref={desktopContentRef}
      >
        <Command
          shouldFilter={false}
          onKeyDown={(event) => { if (!shouldDismissDropdown(event)) event.stopPropagation(); }}
        >
          <CommandInput
            autoFocus
            placeholder={t('session.newWorktree.searchBranches')}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList disableHorizontal>
            {status ? (
              <CommandEmpty>{status}</CommandEmpty>
            ) : sections.map((section) => (
              <CommandGroup key={section.heading} heading={section.heading}>
                {section.branches.map((branch) => (
                  <CommandItem key={branch.value} value={branch.value} onSelect={() => choose(branch)}>
                    <span className="typography-small break-all">{branch.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
