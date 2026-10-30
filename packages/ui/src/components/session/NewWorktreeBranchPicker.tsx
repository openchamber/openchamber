import * as React from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useCommandState } from 'cmdk';

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
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { rankBranchesForQuery } from '@/lib/worktrees/branchSearch';

/** A branch as git names it (`remotes/origin/x` for a remote one) and as it is shown. */
export type PickedBranch = { value: string; label: string };

type BranchSection = { heading: string; branches: PickedBranch[] };

const VIRTUAL_BRANCH_MIN_ROWS = 40;

/** Both the command menu and mobile sheet scroll an ancestor of these rows. */
function VirtualBranchRows({ section, activeValue, isMobile, renderBranch }: {
  section: BranchSection;
  activeValue: string;
  isMobile: boolean;
  renderBranch: (branch: PickedBranch) => React.ReactNode;
}) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = React.useState(0);
  const activeIndex = React.useMemo(
    () => section.branches.findIndex((branch) => branch.value === activeValue),
    [section.branches, activeValue],
  );
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: section.branches.length,
    enabled: scrollElement !== null,
    getScrollElement: () => scrollElement,
    getItemKey: React.useCallback((index) => section.branches[index].value, [section.branches]),
    estimateSize: () => isMobile ? 48 : 32,
    overscan: 8,
    scrollMargin,
    // cmdk navigates the DOM. Keep its active option and neighbours mounted for
    // arrow keys, plus both endpoints for Home/End, even outside the viewport.
    rangeExtractor: React.useCallback((range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      if (!isMobile) {
        for (const index of [0, range.count - 1, activeIndex - 1, activeIndex, activeIndex + 1]) {
          if (index >= 0 && index < range.count) indexes.add(index);
        }
      }
      return [...indexes].sort((a, b) => a - b);
    }, [activeIndex, isMobile]),
  });

  React.useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>('.overlay-scrollbar-target');
    if (!list || !scroller) return;
    setScrollElement(scroller);
    const measureOffset = () => {
      const offset = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setScrollMargin((previous) => Math.abs(previous - offset) < 0.5 ? previous : offset);
    };
    measureOffset();
    const observer = new ResizeObserver(measureOffset);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [section.branches]);

  return (
    <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize(), overflowAnchor: 'none' }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          ref={virtualizer.measureElement}
          data-index={item.index}
          className={cn('absolute inset-s-0 top-0 w-full', isMobile && 'pb-1')}
          style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
        >
          {renderBranch(section.branches[item.index])}
        </div>
      ))}
    </div>
  );
}

function CommandBranchRows(props: Omit<React.ComponentProps<typeof VirtualBranchRows>, 'activeValue'>) {
  const activeValue = useCommandState((state) => state.value ?? '');
  return <VirtualBranchRows {...props} activeValue={activeValue} />;
}

/**
 * One branch choice of the New Worktree dialog, searchable: a dropdown on
 * desktop, a sheet on mobile. Matches rank first while searching; otherwise
 * local branches, then remote ones.
 */
export function NewWorktreeBranchPicker({
  value,
  placeholder,
  title,
  localBranches,
  remoteBranches,
  isLoading,
  isMobile,
  disabled = false,
  onSelect,
}: {
  value: string;
  placeholder: string;
  /** The mobile sheet's title. */
  title: string;
  localBranches: string[];
  remoteBranches: string[];
  isLoading: boolean;
  isMobile: boolean;
  /** Shown, but not applicable to the current choice. */
  disabled?: boolean;
  onSelect: (branch: PickedBranch) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const desktopContentRef = React.useRef<HTMLDivElement | null>(null);
  const mobileListRef = React.useRef<HTMLDivElement | null>(null);

  const searching = query.trim().length > 0;
  const sections = React.useMemo((): BranchSection[] => {
    const ranked = rankBranchesForQuery({ localBranches, remoteBranches, query });
    if (searching) {
      return ranked.matching.length > 0
        ? [{ heading: t('session.newWorktree.matchingBranches'), branches: ranked.matching.map(({ value: branch, label }) => ({ value: branch, label })) }]
        : [];
    }
    return [
      { heading: t('session.newWorktree.localBranches'), branches: ranked.otherLocal.map((branch) => ({ value: branch, label: branch })) },
      { heading: t('session.newWorktree.remoteBranches'), branches: ranked.otherRemote.map((branch) => ({ value: `remotes/${branch}`, label: branch })) },
    ].filter((section) => section.branches.length > 0);
  }, [localBranches, remoteBranches, query, searching, t]);

  // A new query starts the list from the top.
  React.useEffect(() => {
    if (!open) return;
    if (isMobile) {
      const scroller = mobileListRef.current?.closest<HTMLElement>('.overlay-scrollbar-target');
      if (scroller) scroller.scrollTop = 0;
      return;
    }
    const list = desktopContentRef.current?.querySelector<HTMLElement>('[data-slot="command-list"]');
    if (list) list.scrollTop = 0;
  }, [open, query, isMobile]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  };
  const choose = (branch: PickedBranch) => {
    onSelect(branch);
    changeOpen(false);
  };

  const renderRows = (section: BranchSection, renderBranch: (branch: PickedBranch) => React.ReactNode) => (
    section.branches.length >= VIRTUAL_BRANCH_MIN_ROWS
      ? isMobile
        ? <VirtualBranchRows section={section} activeValue="" isMobile renderBranch={renderBranch} />
        : <CommandBranchRows section={section} isMobile={false} renderBranch={renderBranch} />
      : section.branches.map(renderBranch)
  );

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
        <MobileOverlayPanel open={open} title={title} onClose={() => changeOpen(false)}>
          <div className="space-y-4" ref={mobileListRef}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('session.newWorktree.searchBranches')}
              className="h-8"
            />
            {status ? (
              <div className="px-2 py-8 text-center typography-small text-muted-foreground">{status}</div>
            ) : sections.map((section) => (
              <div key={section.heading} className="space-y-2">
                <div className="px-2 typography-small font-semibold text-foreground">{section.heading}</div>
                <div className="space-y-1">
                  {renderRows(section, (branch) => (
                    <button
                      key={branch.value}
                      type="button"
                      onClick={() => choose(branch)}
                      className={cn(
                        'w-full rounded-md px-3 py-2.5 text-start transition-colors',
                        value === branch.value ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
                      )}
                    >
                      <span className="typography-small break-all">{branch.label}</span>
                    </button>
                  ))}
                </div>
              </div>
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
          onKeyDown={(event) => {
            handleDropdownNavigationKey(event, (key) => {
              event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            });
            // Let cmdk handle input/navigation and leave dismissal to the menu.
            if (event.key !== 'Escape') event.stopPropagation();
          }}
        >
          <CommandInput
            placeholder={t('session.newWorktree.searchBranches')}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList disableHorizontal>
            {status ? (
              <CommandEmpty>{status}</CommandEmpty>
            ) : sections.map((section, index) => (
              <React.Fragment key={section.heading}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={section.heading}>
                  {renderRows(section, (branch) => (
                    <CommandItem key={branch.value} value={branch.value} onSelect={() => choose(branch)}>
                      <span className="typography-small break-all">{branch.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </React.Fragment>
            ))}
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
