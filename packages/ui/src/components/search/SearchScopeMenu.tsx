import React from 'react';

import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { OmniFilters } from '@/lib/search/omniQuery';

type ScopeChoice = { value: string; label: string };
const choiceKeys = {
  lifecycle: { active: 'search.omni.lifecycle.active', archived: 'search.omni.lifecycle.archived', all: 'search.omni.lifecycle.all' },
  searchIn: { everything: 'search.omni.searchIn.everything', titles: 'search.omni.searchIn.titles' },
  author: { any: 'search.omni.author.any', user: 'search.omni.author.user', assistant: 'search.omni.author.assistant', reasoning: 'search.omni.author.reasoning' },
} as const;
// Mobile chips stay inside the panel: the group takes the panel width, each option
// shrinks to it, and every option keeps a 44px tap target.
const MOBILE_CHIP_GROUP_CLASS = '[&>button]:min-h-[44px] [&>button]:min-w-0 [&>button]:max-w-full';
type Props = { filters: OmniFilters; defaults: Required<Pick<OmniFilters, 'lifecycle' | 'searchIn'>>; options: { lifecycle: boolean; project: { currentAvailable: boolean } | null; searchIn: boolean; author: boolean }; projectOptions?: readonly ScopeChoice[]; worktreeOptions?: readonly ScopeChoice[]; onChange: (key: keyof OmniFilters, value: string | null) => void; resultCount: number | null; layout: 'sidebar' | 'mobile' };
export const SearchScopeMenu: React.FC<Props> = ({ filters, defaults, options, projectOptions, worktreeOptions, onChange, resultCount, layout }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const lifecycle = filters.lifecycle ?? defaults.lifecycle;
  const searchIn = filters.searchIn ?? defaults.searchIn;
  const groups: Array<{ key: 'lifecycle' | 'project' | 'worktree' | 'searchIn' | 'author'; value: string; values: readonly string[] }> = [];
  if (options.lifecycle) groups.push({ key: 'lifecycle', value: lifecycle, values: ['active', 'archived', 'all'] });
  if (projectOptions) groups.push({ key: 'project', value: filters.project ?? '', values: ['', ...projectOptions.map((option) => option.value)] });
  else if (options.project) groups.push({ key: 'project', value: filters.project ? 'current' : 'all', values: ['all', 'current'] });
  if (worktreeOptions) groups.push({ key: 'worktree', value: filters.worktree ?? '', values: ['', ...worktreeOptions.map((option) => option.value)] });
  if (options.searchIn) groups.push({ key: 'searchIn', value: searchIn, values: ['everything', 'titles'] });
  if (options.author) groups.push({ key: 'author', value: filters.author ?? 'any', values: ['any', 'user', 'assistant'] });
  const change = (key: typeof groups[number]['key'], value: string) => onChange(key, ((key === 'project' || key === 'worktree') && value === '') || (key === 'project' && !projectOptions && value === 'all') ? null : value);
  const isDisabled = (key: string, value: string) => key === 'project' && !projectOptions && value === 'current' && !options.project?.currentAvailable;
  const groupLabel = (key: typeof groups[number]['key']) => t(key === 'worktree' ? 'sessions.sidebar.sessionDialogs.worktree.label' : `search.omni.${key}.label`);
  const choiceLabel = (key: typeof groups[number]['key'], value: string) => {
    if (key === 'project') return value === '' || (!projectOptions && value === 'all') ? t('search.omni.project.all') : projectOptions?.find((option) => option.value === value)?.label ?? (projectOptions ? value : t('search.omni.project.current'));
    if (key === 'worktree') return value === '' ? t('search.omni.category.all') : worktreeOptions?.find((option) => option.value === value)?.label ?? value;
    if (layout === 'mobile' && key === 'lifecycle' && value === 'all') return t('search.omni.lifecycle.allShort');
    const labelKey = Object.entries(choiceKeys[key]).find(([option]) => option === value)?.[1];
    return labelKey ? t(labelKey) : value;
  };
  const content = layout === 'mobile'
    ? <div data-search-scope-panel="mobile" className="flex flex-col gap-4 p-2">
      {groups.map(({ key, value, values }) => <div key={key} data-search-scope-control={key} className="flex min-w-0 flex-col items-start gap-2">
        <span className="typography-ui-label text-muted-foreground">{groupLabel(key)}</span>
        <SettingsChipGroup className={MOBILE_CHIP_GROUP_CLASS} value={value} aria-label={groupLabel(key)} onChange={(next) => change(key, next)} options={values.map((option) => ({ value: option, label: <span className="truncate">{choiceLabel(key, option)}</span>, disabled: isDisabled(key, option) }))} />
      </div>)}
    </div>
    : <DropdownMenuContent data-search-scope-panel="sidebar" align="start">
      {groups.map(({ key, value, values }) => <DropdownMenuRadioGroup key={key} data-search-scope-control={key} aria-label={groupLabel(key)} value={value} onValueChange={(next) => change(key, next)}>
        <DropdownMenuLabel>{groupLabel(key)}</DropdownMenuLabel>
        {values.map((option) => <DropdownMenuRadioItem key={option} data-search-scope-option={`${key}:${option}`} value={option} disabled={isDisabled(key, option)}>{choiceLabel(key, option)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>)}
    </DropdownMenuContent>;
  const projectLabel = projectOptions?.find((option) => option.value === filters.project)?.label ?? (filters.project === 'current' && !projectOptions ? t('search.omni.project.current') : filters.project) ?? t('search.omni.project.all');
  const summary = [t('search.omni.scopeSummary', { lifecycle: t(`search.omni.lifecycle.${lifecycle}`), project: projectLabel }), filters.worktree ? choiceLabel('worktree', filters.worktree) : null].filter(Boolean).join(' · ');
  if (layout === 'mobile') return <div data-search-scope-menu="mobile"><Button data-search-scope-trigger variant="outline" size="sm" className="min-h-[44px]" aria-label={t('search.omni.filters.aria')} aria-expanded={open} onClick={() => setOpen(true)}>{t('search.omni.filters.buttonWithCount', { count: Object.keys(filters).length })}</Button><MobileOverlayPanel open={open} title={t('search.omni.filters.button')} onClose={() => setOpen(false)}>{content}</MobileOverlayPanel></div>;
  return <div data-search-scope-menu="sidebar" className="flex min-w-0 items-center justify-between gap-2">
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger data-search-scope-trigger className={`${dropdownTriggerVariants()} min-w-0 max-w-full`}><span className="truncate">{summary}</span><Icon name="arrow-down-s" className="size-3" /></DropdownMenuTrigger>
      {content}
    </DropdownMenu>
    <span data-search-scope-count className="shrink-0 typography-micro text-muted-foreground">{resultCount}</span>
  </div>;
};
