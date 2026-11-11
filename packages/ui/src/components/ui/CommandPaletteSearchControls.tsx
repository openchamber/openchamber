import React from 'react';

import { SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { SearchCountBadge } from '@/components/search/SearchCountBadge';
import { useI18n } from '@/lib/i18n';
import { searchFilterChipKeys } from '@/components/search/searchFilterChipKeys';
import type { OmniCategory, OmniFilters } from '@/lib/search/omniQuery';
import { Button } from './button';
import { dropdownTriggerVariants } from './dropdown-trigger';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './dropdown-menu';
import { MobileOverlayPanel } from './MobileOverlayPanel';

type Choice = { value: string; label: string };
type Props = {
  filters: OmniFilters;
  category: OmniCategory;
  onFilterChange: <K extends keyof OmniFilters>(key: K, value: OmniFilters[K] | null) => void;
  projects: readonly Choice[];
  worktrees: readonly Choice[];
  mobile: boolean;
  allowArchived: boolean;
  reasoningAvailable: boolean;
  onRefocus: () => void;
  filterButtonRef?: React.RefObject<HTMLButtonElement | null>;
};
type FilterGroup = { key: keyof OmniFilters; label: string; value: string; options: Choice[]; select: (value: string) => void };
const CATEGORIES: readonly OmniCategory[] = ['all', 'sessions', 'messages', 'commands', 'files'];

export function CommandPaletteSearchControls({ filters, category, onFilterChange, projects, worktrees, mobile, allowArchived, reasoningAvailable, onRefocus, filterButtonRef }: Props) {
  const { t, direction } = useI18n();
  const [open, setOpen] = React.useState(false);
  const pendingRefocus = React.useRef(false);
  const searchOwnsDismissFocus = React.useRef(false);

  const setFiltersOpen = React.useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      pendingRefocus.current = false;
      searchOwnsDismissFocus.current = false;
    }
    setOpen(nextOpen);
  }, []);
  const refocusAfterDismiss = React.useCallback(() => {
    if (!pendingRefocus.current) return;
    pendingRefocus.current = false;
    onRefocus();
  }, [onRefocus]);
  React.useLayoutEffect(() => {
    // The shared mobile panel unmounts its portal synchronously on close.
    if (mobile && !open) refocusAfterDismiss();
  }, [mobile, open, refocusAfterDismiss]);

  const selectFilter = <K extends keyof OmniFilters>(key: K, value: OmniFilters[K] | null) => {
    pendingRefocus.current = true;
    searchOwnsDismissFocus.current = true;
    onFilterChange(key, value);
    setOpen(false);
  };
  const defaultLifecycle = allowArchived ? 'all' : 'active';
  const filterDefaults = { lifecycle: defaultLifecycle, searchIn: 'everything', author: 'any' } as const;
  const lifecycle = allowArchived ? filters.lifecycle ?? defaultLifecycle : 'active';
  const lifecycleOptions: readonly ('active' | 'archived' | 'all')[] = allowArchived ? ['active', 'archived', 'all'] : ['active'];
  const authors: readonly ('any' | 'user' | 'assistant' | 'reasoning')[] = reasoningAvailable ? ['any', 'user', 'assistant', 'reasoning'] : ['any', 'user', 'assistant'];
  const groups: FilterGroup[] = [
    { key: 'lifecycle', label: t('search.omni.lifecycle.label'), value: lifecycle,
      options: lifecycleOptions.map((value) => ({ value, label: t(`search.omni.lifecycle.${mobile && value === 'all' ? 'allShort' : value}`) })),
      select: (value) => { const option = lifecycleOptions.find((entry) => entry === value); if (option) selectFilter('lifecycle', option === 'all' && defaultLifecycle === 'all' ? null : option); } },
    { key: 'searchIn', label: t('search.omni.searchIn.label'), value: filters.searchIn ?? 'everything',
      options: (['everything', 'titles'] as const).map((value) => ({ value, label: t(`search.omni.searchIn.${value}`) })),
      select: (value) => selectFilter('searchIn', value === 'titles' ? 'titles' : null) },
    { key: 'author', label: t('search.omni.author.label'), value: filters.author ?? 'any',
      options: authors.map((value) => ({ value, label: t(`search.omni.author.${value}`) })),
      select: (value) => { const option = authors.find((entry) => entry === value); if (option) selectFilter('author', option === 'any' ? null : option); } },
    { key: 'project', label: t('search.omni.project.label'), value: filters.project ?? '',
      options: [{ value: '', label: t('search.omni.project.all') }, ...projects], select: (value) => selectFilter('project', value || null) },
    { key: 'worktree', label: t('sessions.sidebar.sessionDialogs.worktree.label'), value: filters.worktree ?? '',
      options: [{ value: '', label: t('search.omni.category.all') }, ...worktrees], select: (value) => selectFilter('worktree', value || null) },
  ];
  const activeCount = searchFilterChipKeys(filters, filterDefaults).length;
  const triggerProps = {
    ref: filterButtonRef,
    'data-palette-filters-trigger': true,
    'aria-label': activeCount ? t('search.omni.filters.ariaActive', { count: activeCount }) : t('search.omni.filters.aria'),
    title: t('search.omni.filters.shortcutHint', { shortcut: 'Alt+↓' }),
    className: `${dropdownTriggerVariants({ size: mobile ? 'touch' : 'default' })} shrink-0`,
  };

  return <div data-palette-search-controls className="flex min-w-0 flex-nowrap items-center gap-2 px-3 py-2">
    <div data-palette-categories role="tablist" aria-label={t('search.omni.category.label')} className="oc-recessed flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 rounded-lg p-0.5"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const current = tabs.findIndex((tab) => tab === event.target);
        if (current < 0) return;
        event.preventDefault();
        event.stopPropagation();
        const delta = (event.key === 'ArrowRight' ? 1 : -1) * (direction === 'rtl' ? -1 : 1);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + delta + tabs.length) % tabs.length;
        tabs[next]?.focus();
      }}>
      {CATEGORIES.map((value) => <Button key={value} data-palette-category={value} type="button" role="tab" aria-selected={category === value} tabIndex={category === value ? 0 : -1}
        variant="ghost" size={mobile ? 'default' : 'sm'}
        className={`min-w-0 flex-1 truncate rounded-md !font-normal ${category === value ? 'oc-raised bg-[var(--surface-background)] text-foreground dark:bg-surface-elevated' : 'text-muted-foreground'}`}
        onClick={() => { onFilterChange('category', value === 'all' ? null : value); onRefocus(); }}>
        <span className="truncate">{t(`search.omni.category.${value}`)}</span>
      </Button>)}
    </div>
    {mobile ? <>
      <button {...triggerProps} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setFiltersOpen(!open)}>{t('search.omni.filters.button')}<SearchCountBadge count={activeCount} /></button>
      <MobileOverlayPanel open={open} title={t('search.omni.filters.aria')} onClose={() => setFiltersOpen(false)}>
        <div data-palette-filters-panel="mobile" className="flex min-w-0 flex-col gap-4 p-2">
          {groups.map((group) => <div key={group.key} data-palette-filter-group={group.key} className="flex min-w-0 flex-col items-start gap-1">
            <span className="typography-ui-label text-muted-foreground">{group.label}</span>
            {group.key === 'lifecycle' ? <SettingsChipGroup aria-label={group.label} value={group.value} options={group.options} onChange={group.select} />
              : <div role="radiogroup" aria-label={group.label} className="flex w-full min-w-0 flex-col">
                {group.options.map((option) => <Button key={option.value} data-palette-filter-option={`${group.key}:${option.value}`} role="radio" aria-checked={group.value === option.value}
                  type="button" variant="chip" size="lg" className="max-w-full justify-start" aria-pressed={group.value === option.value} onClick={() => group.select(option.value)}>
                  <span dir="auto" className="truncate oc-ui-start-align">{option.label}</span>
                </Button>)}
              </div>}
          </div>)}
        </div>
      </MobileOverlayPanel>
    </> : <DropdownMenu open={open} onOpenChange={setFiltersOpen} onOpenChangeComplete={(isOpen) => { if (!isOpen) refocusAfterDismiss(); }}>
      <DropdownMenuTrigger {...triggerProps}>{t('search.omni.filters.button')}<SearchCountBadge count={activeCount} /></DropdownMenuTrigger>
      <DropdownMenuContent data-palette-filters-panel="desktop" align="end" className="max-h-[min(70vh,32rem)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto" finalFocus={() => !searchOwnsDismissFocus.current}>
        {groups.map((group) => <DropdownMenuRadioGroup key={group.key} data-palette-filter-group={group.key} aria-label={group.label} value={group.value}>
          <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
          {group.options.map((option) => <DropdownMenuRadioItem key={option.value} data-palette-filter-option={`${group.key}:${option.value}`} value={option.value} closeOnClick onClick={() => group.select(option.value)}>
            <span dir="auto" className="min-w-0 truncate oc-ui-start-align">{option.label}</span>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>)}
      </DropdownMenuContent>
    </DropdownMenu>}
  </div>;
}
