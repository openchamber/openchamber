import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { TimelineProjectIcon } from '@/components/session/sidebar/sessions/SessionTimelineRowBody';
import { useI18n } from '@/lib/i18n';
import type { OmniFilters } from '@/lib/search/omniQuery';
import { cn } from '@/lib/utils';
import { SEARCH_FILTER_VALUE_LABEL_KEYS, searchFilterChipKeys } from './searchFilterChipKeys';

type ProjectOption = {
  value: string;
  label: string;
  id?: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

type WorktreeOption = { value: string; label: string };

type SearchFilterChipsProps = {
  filters: OmniFilters;
  defaults: Partial<Pick<OmniFilters, 'lifecycle' | 'searchIn' | 'author'>>;
  projectOptions?: readonly ProjectOption[];
  worktreeOptions?: readonly WorktreeOption[];
  onRemove: (key: keyof OmniFilters) => void;
  mobile?: boolean;
};

const FILTER_GROUP_LABEL_KEYS = { lifecycle: 'search.omni.lifecycle.label', searchIn: 'search.omni.searchIn.label', author: 'search.omni.author.label' } as const;


const pathSegment = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;

export function SearchFilterChips({ filters, defaults, projectOptions, worktreeOptions, onRemove, mobile = false }: SearchFilterChipsProps) {
  const { t } = useI18n();
  const keys = searchFilterChipKeys(filters, defaults);
  if (keys.length === 0) return null;
  const fixedValueLabel = (key: keyof typeof SEARCH_FILTER_VALUE_LABEL_KEYS, value: string) => {
    const labelKey = Object.entries(SEARCH_FILTER_VALUE_LABEL_KEYS[key]).find(([option]) => option === value)?.[1];
    return labelKey ? t(labelKey) : value;
  };

  return <ul data-search-filter-chips role="list" aria-label={t('search.omni.chip.list')} className="contents">
    {keys.map((key) => {
      const value = filters[key];
      if (value === undefined) return null;
      const project = key === 'project' ? projectOptions?.find((option) => option.value === value) : undefined;
      const worktree = key === 'worktree' ? worktreeOptions?.find((option) => option.value === value) : undefined;
      const label = key === 'project' ? project?.label ?? pathSegment(value)
        : key === 'worktree' ? worktree?.label ?? pathSegment(value)
          : fixedValueLabel(key, value);
      const title = key === 'project' || key === 'worktree' ? value : `${t(FILTER_GROUP_LABEL_KEYS[key])}: ${label}`;
      const dir = key === 'worktree' ? 'ltr' : 'auto';
      const icon = key === 'project'
        ? project?.id
          ? <TimelineProjectIcon project={{ ...project, id: project.id }} label={null} />
          : <Icon name="folder" className="size-3 shrink-0 text-muted-foreground" />
        : key === 'worktree' ? <Icon name="git-branch" className="size-3 shrink-0 text-muted-foreground" /> : null;

      return <li key={key} data-search-filter-chip={key} className={cn('flex min-w-0 max-w-full items-center', mobile && 'min-h-11')}>
        <span title={title} className={cn('oc-tile-inset inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm ps-1.5 pe-0.5 typography-meta text-foreground', mobile ? 'h-7' : 'h-6')}>
          {icon}
          <span dir={dir} className={cn('min-w-0 max-w-[10rem] truncate', dir === 'auto' && 'oc-ui-start-align')}>{label}</span>
          <button type="button" data-search-filter-chip-remove={key} aria-label={t('search.omni.chip.remove', { name: label })} className={cn("relative inline-flex shrink-0 items-center justify-center rounded-[3px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:bg-interactive-hover focus-visible:text-foreground focus-visible:outline-none", mobile ? "size-6 before:absolute before:inset-0 before:m-auto before:size-11 before:content-['']" : 'size-5')} onClick={() => onRemove(key)}>
            <Icon name="close" className="size-3" />
          </button>
        </span>
      </li>;
    })}
  </ul>;
}
