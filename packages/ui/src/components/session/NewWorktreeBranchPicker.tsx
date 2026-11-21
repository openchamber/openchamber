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
  CommandSeparator,
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
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { rankBranchesForQuery } from '@/lib/worktrees/branchSearch';

export type PickedBranch = { value: string; label: string };

type BranchSection = { heading: string; branches: PickedBranch[] };

const RENDER_STEP = 200;

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
  remoteDefaults,
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
  remoteDefaults?: readonly string[];
  isLoading: boolean;
  isMobile: boolean;
  disabled?: boolean;
  onSelect: (branch: PickedBranch) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [renderLimit, setRenderLimit] = React.useState(RENDER_STEP);
  const desktopContentRef = React.useRef<HTMLDivElement | null>(null);
  const mobileListRef = React.useRef<HTMLDivElement | null>(null);

  const searching = query.trim().length > 0;
  const sections = React.useMemo((): BranchSection[] => {
    const ranked = rankBranchesForQuery({ localBranches, remoteBranches, remoteDefaults, query });
    if (searching) {
      return ranked.matching.length > 0
        ? [{ heading: t('session.newWorktree.matchingBranches'), branches: ranked.matching.map(({ value: branch, label }) => ({ value: branch, label })) }]
        : [];
    }
    const remote = (branch: string): PickedBranch => ({ value: `remotes/${branch}`, label: branch });
    return [
      { heading: t('session.newWorktree.defaultBranches'), branches: ranked.remoteDefaults.map(remote) },
      { heading: t('session.newWorktree.localBranches'), branches: ranked.otherLocal.map((branch) => ({ value: branch, label: branch })) },
      { heading: t('session.newWorktree.remoteBranches'), branches: ranked.otherRemote.map(remote) },
    ].filter((section) => section.branches.length > 0);
  }, [localBranches, remoteBranches, remoteDefaults, query, searching, t]);

  const total = sections.reduce((count, section) => count + section.branches.length, 0);
  let offset = 0;
  const visibleSections = sections.map((section) => {
    const end = Math.max(0, renderLimit - offset);
    offset += section.branches.length;
    return { ...section, branches: section.branches.slice(0, end) };
  }).filter((section) => section.branches.length > 0);
  const hasMore = renderLimit < total;

  const observeListEnd = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return undefined;
    const root = node.closest<HTMLElement>('[data-slot="command-list"]') ?? findScrollableAncestor(node.parentElement);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setRenderLimit((limit) => limit + RENDER_STEP);
    }, { root, rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
    if (!next) { setQuery(''); setRenderLimit(RENDER_STEP); }
  };
  const choose = (branch: PickedBranch) => {
    onSelect(branch);
    changeOpen(false);
  };

  const changeQuery = (next: string) => { setRenderLimit(RENDER_STEP); setQuery(next); };
  const listEndMarker = open && hasMore ? <div ref={observeListEnd} aria-hidden="true" className="h-px" /> : null;

  const noBranches = localBranches.length === 0 && remoteBranches.length === 0;
  const status = isLoading
    ? t('session.newWorktree.loadingBranches')
    : noBranches
      ? t('session.newWorktree.noBranchesFound')
      : searching && sections.length === 0
        ? t('session.newWorktree.noMatchingBranches')
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
          subheader={<MobileSheetSearch value={query} onChange={changeQuery} placeholder={t('session.newWorktree.searchBranches')} />}
        >
          <div ref={mobileListRef}>
            {status ? (
              <div className="px-2 py-8 text-center typography-meta text-muted-foreground">{status}</div>
            ) : visibleSections.map((section) => (
              <MobileSheetSection key={section.heading} title={section.heading}>
                {section.branches.map((branch) => (
                  <MobileSheetRow key={branch.value} selected={value === branch.value} onClick={() => choose(branch)}>
                    {branch.label}
                  </MobileSheetRow>
                ))}
              </MobileSheetSection>
            ))}
            {status ? null : listEndMarker}
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
            onValueChange={changeQuery}
          />
          <CommandList disableHorizontal>
            {status ? (
              <CommandEmpty>{status}</CommandEmpty>
            ) : visibleSections.map((section, index) => (
              <React.Fragment key={section.heading}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={section.heading}>
                  {section.branches.map((branch) => (
                    <CommandItem key={branch.value} value={branch.value} onSelect={() => choose(branch)}>
                      <span className="typography-small break-all">{branch.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </React.Fragment>
            ))}
            {status ? null : listEndMarker}
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
