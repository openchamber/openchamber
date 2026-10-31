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
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { Label, MilestoneChoice } from '@/lib/api/types';
import { cn } from '@/lib/utils';

import { REPOSITORY_PEOPLE, REPOSITORY_PEOPLE_LABEL_KEYS, REPOSITORY_STATE_LABEL_KEYS, REPOSITORY_STATES, type IssueFilter } from './referencePickerItems';
import type { ChoiceOptionsState } from './issueFilterOptions';

export type IssueFilterMenuProps = {
  filter: IssueFilter;
  onFilterChange: (patch: Partial<IssueFilter>) => void;
  /** The label options; `null` while the host is unknown. */
  labels: ChoiceOptionsState<Label> | null;
  milestones: ChoiceOptionsState<MilestoneChoice> | null;
  /** Which dropdowns the host offers; both must be on for the menu to render the extras. */
  showLabel: boolean;
  showMilestone: boolean;
  isMobile?: boolean;
};

/**
 * The groups and dropdowns of the issues filter, without the menu wrapper: a
 * surface that owns its own filter trigger renders them inside its content.
 */
export const IssueFilterGroups: React.FC<Omit<IssueFilterMenuProps, 'isMobile'>> = ({ filter, onFilterChange, labels, milestones, showLabel, showMilestone }) => {
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

  // A name dropdown: the host's options, single-select, "All" clears it.
  const nameDropdown = <T extends { name: string }>(what: 'label' | 'milestone', state: ChoiceOptionsState<T> | null, selected: string[], onSelect: (names: string[]) => void) => {
    const ready = state && state.status === 'ready' ? state : null;
    const firstFailure = state && state.status === 'error' ? state : null;
    const loading = !ready && !firstFailure;
    return (
      <>
        <DropdownMenuLabel>
          {what === 'label' ? t('issuesPanel.filter.label') : t('issuesPanel.filter.milestone')}
          {ready?.stale ? <span className="ms-1.5 text-muted-foreground">{t('issuesPanel.filter.stale')}</span> : null}
        </DropdownMenuLabel>
        {firstFailure ? (
          <div className="px-2 py-1.5 typography-meta text-muted-foreground">{t('issuesPanel.filter.unavailable', { what: what === 'label' ? t('issuesPanel.filter.label') : t('issuesPanel.filter.milestone') })}</div>
        ) : loading ? (
          <div className="px-2 py-1.5 typography-meta text-muted-foreground">…</div>
        ) : (
          <DropdownMenuRadioGroup value={selected[0] ?? 'all'} onValueChange={(next) => onSelect(next === 'all' ? [] : [next])}>
            <DropdownMenuRadioItem value="all">{t('issuesPanel.filter.all')}</DropdownMenuRadioItem>
            {(ready?.items ?? []).map((item) => <DropdownMenuRadioItem key={item.name} value={item.name}>{item.name}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        )}
      </>
    );
  };

  return (
    <>
      {group(t('references.picker.filter.group.status'), filter.state, REPOSITORY_STATES.issue, (option) => t(REPOSITORY_STATE_LABEL_KEYS[option]), (option) => onFilterChange({ state: option }))}
      <DropdownMenuSeparator />
      {group(t('references.picker.filter.group.people'), filter.people, REPOSITORY_PEOPLE.issue, (option) => t(REPOSITORY_PEOPLE_LABEL_KEYS[option]), (option) => onFilterChange({ people: option }))}
      {showMilestone ? (<><DropdownMenuSeparator />{nameDropdown('milestone', milestones, filter.milestoneNames, (names) => onFilterChange({ milestoneNames: names }))}</>) : null}
      {showLabel ? (<><DropdownMenuSeparator />{nameDropdown('label', labels, filter.labelNames, (names) => onFilterChange({ labelNames: names }))}</>) : null}
    </>
  );
};

/** The issues filter: state and people like the board's, plus host-provided label and milestone dropdowns. */
export const IssueFilterMenu: React.FC<IssueFilterMenuProps> = ({ isMobile, ...groups }) => {
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
        <IssueFilterGroups {...groups} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
