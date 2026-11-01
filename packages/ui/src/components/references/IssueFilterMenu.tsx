import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { Label, MilestoneChoice } from '@/lib/api/types';
import { cn } from '@/lib/utils';

import { REPOSITORY_PEOPLE, REPOSITORY_PEOPLE_LABEL_KEYS, REPOSITORY_STATE_LABEL_KEYS, REPOSITORY_STATES, type IssueFilter } from './referencePickerItems';
import type { ChoiceOptionsState } from './issueFilterOptions';

export type IssueFilterMenuProps = {
  filter: IssueFilter;
  onFilterChange: (patch: Partial<IssueFilter>) => void;
  isMobile?: boolean;
};

export type IssueFilterSelectsProps = {
  filter: IssueFilter;
  onFilterChange: (patch: Partial<IssueFilter>) => void;
  /** The label options; `null` where the surface offers none. */
  labels: ChoiceOptionsState<Label> | null;
  milestones: ChoiceOptionsState<MilestoneChoice> | null;
  /** Which selects the host offers. */
  showLabel?: boolean;
  showMilestone?: boolean;
};

/**
 * The groups of the issues filter, without the menu wrapper: a surface that
 * owns its own filter trigger renders them inside its content. The name
 * filters live beside the trigger as `IssueFilterSelects`.
 */
export const IssueFilterGroups: React.FC<Pick<IssueFilterMenuProps, 'filter' | 'onFilterChange'>> = ({ filter, onFilterChange }) => {
  const { t } = useI18n();

  const group = <T extends string>(label: string, value: T, options: readonly T[], labelOf: (option: T) => string, onSelect: (option: T) => void) => (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value} onValueChange={(next) => {
        const option = options.find((entry) => entry === next);
        if (option) onSelect(option);
      }}>
        {options.map((option) => <DropdownMenuRadioItem key={option} value={option}>{labelOf(option)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </>
  );

  return (
    <>
      {group(t('references.picker.filter.group.status'), filter.state, REPOSITORY_STATES.issue, (option) => t(REPOSITORY_STATE_LABEL_KEYS[option]), (option) => onFilterChange({ state: option }))}
      <DropdownMenuSeparator />
      {group(t('references.picker.filter.group.people'), filter.people, REPOSITORY_PEOPLE.issue, (option) => t(REPOSITORY_PEOPLE_LABEL_KEYS[option]), (option) => onFilterChange({ people: option }))}
    </>
  );
};

/** The one name filter as a compact select: single-select, "All" clears it. */
const IssueFilterNameSelect: React.FC<{
  what: 'label' | 'milestone';
  selected: string[];
  options: ChoiceOptionsState<{ name: string }>;
  onSelect: (names: string[]) => void;
}> = ({ what, selected, options, onSelect }) => {
  const { t } = useI18n();
  const name = what === 'label' ? t('issuesPanel.filter.label') : t('issuesPanel.filter.milestone');
  const allLabel = what === 'label' ? t('issuesPanel.filter.allLabels') : t('issuesPanel.filter.allMilestones');
  const value = selected[0] ?? 'all';
  // A failed first read disables the select with its note: never an
  // empty-looking list. A failed refresh keeps the last list, marked stale.
  const unavailable = t('issuesPanel.filter.unavailable', { what: name });
  return (
    <Select
      value={value}
      disabled={options.status !== 'ready'}
      onValueChange={(next) => onSelect(next === 'all' ? [] : [next])}
    >
      <SelectTrigger
        aria-label={name}
        title={options.status === 'ready' && options.stale ? t('issuesPanel.filter.stale') : undefined}
        className="max-w-[9rem] typography-micro"
      >
        <SelectValue placeholder={options.status === 'error' ? unavailable : '…'}>
          {options.status === 'ready' ? (value === 'all' ? allLabel : value) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.items.map((item) => (
          <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/**
 * The host-provided name filters beside the issues filter menu: a compact
 * select each, label then milestone. Each reads its own options state, so a
 * failure in one never blocks the other.
 */
export const IssueFilterSelects: React.FC<IssueFilterSelectsProps> = ({ filter, onFilterChange, labels, milestones, showLabel, showMilestone }) => (
  <>
    {showLabel && labels ? (
      <IssueFilterNameSelect
        what="label"
        selected={filter.labelNames}
        options={labels}
        onSelect={(names) => onFilterChange({ labelNames: names })}
      />
    ) : null}
    {showMilestone && milestones ? (
      <IssueFilterNameSelect
        what="milestone"
        selected={filter.milestoneNames}
        options={milestones}
        onSelect={(names) => onFilterChange({ milestoneNames: names })}
      />
    ) : null}
  </>
);

/** The issues filter: state and people, like the board's. The name filters sit beside it (`IssueFilterSelects`). */
export const IssueFilterMenu: React.FC<IssueFilterMenuProps> = ({ filter, onFilterChange, isMobile }) => {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t('references.picker.filter.label')} className={cn(dropdownTriggerVariants({ size: isMobile ? 'mobile' : 'default' }), 'min-w-0 max-w-[18rem] shrink-0', isMobile && 'max-w-[45%]')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon name="filter-3" className="size-4" />
            <span className="truncate">{t('issuesPanel.filter.label')}</span>
          </span>
          <Icon name="arrow-down-s" className="size-4 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <IssueFilterGroups filter={filter} onFilterChange={onFilterChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
