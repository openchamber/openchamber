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
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { rankBranchesForQuery } from '@/lib/worktrees/branchSearch';

export type PickedBranch = { value: string; label: string };

/** A titled group of choices shown above the branch lists. */
export type BranchPickerSection = { heading: string; branches: PickedBranch[] };

/** A pull request offered while the search is its number. */
type BranchPickerPullRequests = {
  heading: string;
  label: (number: number) => string;
  onPick: (number: number) => void;
};

type PickerRow = PickedBranch & { pullRequest?: number };
type PickerSection = { heading: string; rows: readonly PickerRow[] };

const PULL_REQUEST_QUERY = /^[#!]?(\d{1,9})$/;

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
  valueLabel,
  placeholder,
  title,
  localBranches,
  remoteBranches,
  leadingSections = [],
  pullRequests,
  remoteDefaults,
  isLoading,
  isMobile,
  disabled = false,
  variant = 'field',
  onSelect,
}: {
  value: string;
  /** The trigger's text when the value is not what the user reads. */
  valueLabel?: string;
  placeholder: string;
  title: string;
  localBranches: string[];
  remoteBranches: string[];
  /** Choices above the branch lists, searched with them. */
  leadingSections?: readonly BranchPickerSection[];
  /** Offered while the search is a number; absent where a pull request is not a choice. */
  pullRequests?: BranchPickerPullRequests;
  remoteDefaults?: readonly string[];
  isLoading: boolean;
  isMobile: boolean;
  disabled?: boolean;
  /** `inline` is the chrome-less trigger of the composer's target row. */
  variant?: 'field' | 'inline';
  onSelect: (branch: PickedBranch) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [renderLimit, setRenderLimit] = React.useState(RENDER_STEP);
  const desktopContentRef = React.useRef<HTMLDivElement | null>(null);
  const mobileListRef = React.useRef<HTMLDivElement | null>(null);

  const searching = query.trim().length > 0;
  const pullRequestNumber = pullRequests ? Number(PULL_REQUEST_QUERY.exec(query.trim())?.[1] ?? 0) : 0;
  const sections = React.useMemo((): PickerSection[] => {
    const ranked = rankBranchesForQuery({ localBranches, remoteBranches, remoteDefaults, query });
    if (searching) {
      const leading = leadingSections.map((section) => ({
        heading: section.heading,
        rows: rankByQuery(section.branches, query, (branch) => [branch.label]),
      }));
      const pullRequestSection = pullRequests && pullRequestNumber > 0
        ? [{ heading: pullRequests.heading, rows: [{ value: `pull-request:${pullRequestNumber}`, label: pullRequests.label(pullRequestNumber), pullRequest: pullRequestNumber }] }]
        : [];
      return [
        ...pullRequestSection,
        ...leading,
        { heading: t('session.newWorktree.matchingBranches'), rows: ranked.matching },
      ].filter((section) => section.rows.length > 0);
    }
    const remote = (branch: string): PickedBranch => ({ value: `remotes/${branch}`, label: branch });
    return [
      ...leadingSections.map((section) => ({ heading: section.heading, rows: section.branches })),
      { heading: t('session.newWorktree.defaultBranches'), rows: ranked.remoteDefaults.map(remote) },
      { heading: t('session.newWorktree.localBranches'), rows: ranked.otherLocal.map((branch) => ({ value: branch, label: branch })) },
      { heading: t('session.newWorktree.remoteBranches'), rows: ranked.otherRemote.map(remote) },
    ].filter((section) => section.rows.length > 0);
  }, [leadingSections, localBranches, pullRequestNumber, pullRequests, remoteBranches, remoteDefaults, query, searching, t]);

  const total = sections.reduce((count, section) => count + section.rows.length, 0);
  let offset = 0;
  const visibleSections = sections.map((section) => {
    const end = Math.max(0, renderLimit - offset);
    offset += section.rows.length;
    return { ...section, rows: section.rows.slice(0, end) };
  }).filter((section) => section.rows.length > 0);
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
  const choose = (row: PickerRow) => {
    if (row.pullRequest !== undefined) pullRequests?.onPick(row.pullRequest);
    else onSelect({ value: row.value, label: row.label });
    changeOpen(false);
  };

  const changeQuery = (next: string) => { setRenderLimit(RENDER_STEP); setQuery(next); };
  const listEndMarker = open && hasMore ? <div ref={observeListEnd} aria-hidden="true" className="h-px" /> : null;

  const hasChoices = localBranches.length > 0
    || remoteBranches.length > 0
    || leadingSections.some((section) => section.branches.length > 0);
  const status = isLoading
    ? t('session.newWorktree.loadingBranches')
    : !hasChoices && sections.length === 0
      ? t('session.newWorktree.noBranchesFound')
      : searching && sections.length === 0
        ? t('session.newWorktree.noMatchingBranches')
        : null;
  const shownValue = valueLabel ?? value;
  const triggerLabel = (
    <span className={cn('truncate', shownValue ? 'text-foreground' : 'text-muted-foreground')}>{shownValue || placeholder}</span>
  );
  // Rows in different sections may name the same branch (a worktree's branch is
  // also a local branch), so the list's own item value carries the section.
  const itemValue = (section: PickerSection, row: PickerRow) => `${section.heading}:${row.value}`;

  if (isMobile) {
    return (
      <>
        {variant === 'inline' ? (
          <button
            type="button"
            onClick={() => changeOpen(true)}
            disabled={disabled}
            aria-label={title}
            className="inline-flex h-7 min-w-0 max-w-[48vw] cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon name="git-branch" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {triggerLabel}
            <Icon name="arrow-down-s" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        ) : (
        <Button variant="outline" size="sm" onClick={() => changeOpen(true)} disabled={disabled} className="h-8 w-full justify-between">
          {triggerLabel}
          <Icon name="git-branch" className="h-4 w-4 text-muted-foreground" />
        </Button>
        )}
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
                {section.rows.map((branch) => (
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
        {variant === 'inline' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={title}
            className="h-7 min-w-0 w-fit max-w-[42vw] justify-start gap-1 px-1.5 normal-case hover:bg-transparent data-[popup-open]:bg-transparent sm:max-w-[18rem]"
          >
            <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" />
            {triggerLabel}
            <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
          </Button>
        ) : (
          <button type="button" disabled={disabled} className={cn(dropdownTriggerVariants({ size: 'default' }), 'w-full max-w-full disabled:cursor-not-allowed disabled:opacity-50')}>
            {triggerLabel}
            <Icon name="arrow-down-s" className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        portalToBody
        className={cn(
          'flex max-h-[min(var(--available-height),24rem)] flex-col overflow-hidden p-0',
          variant === 'inline' ? 'w-72 max-w-[calc(100vw-2rem)]' : 'w-[var(--anchor-width)] min-w-[16rem]',
        )}
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
                  {section.rows.map((row) => (
                    <CommandItem key={row.value} value={itemValue(section, row)} onSelect={() => choose(row)}>
                      <span className="typography-small break-all">{row.label}</span>
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
