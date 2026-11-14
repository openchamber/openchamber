import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import type { SearchScope } from '@/lib/search/omniQuery';
import { cn } from '@/lib/utils';
import { effectiveSearchScope, useSearchScopes } from './searchScopes';

const SCOPE_LABEL_KEYS = {
  everything: 'search.omni.searchIn.everything',
  titles: 'search.omni.searchIn.titles',
  user: 'search.omni.searchIn.user',
  assistant: 'search.omni.searchIn.assistant',
  reasoning: 'search.omni.searchIn.reasoning',
} as const;

type Props = {
  scope: SearchScope;
  onChange: (scope: SearchScope) => void;
  /** Menu items after the choice, such as saving the search. */
  actions?: React.ReactNode;
  mobile?: boolean;
};

/**
 * The search field's one menu: where to look, then the search's own actions.
 * Its trigger sits inside the field and is pressed while a narrower scope is on.
 */
export function SearchInMenu({ scope, onChange, actions, mobile = false }: Props): React.ReactNode {
  const { t } = useI18n();
  const scopes = useSearchScopes();
  const current = effectiveSearchScope(scope, scopes);
  if (scopes.length === 0 && !actions) return null;
  const label = scopes.length > 0
    ? t('search.omni.searchIn.trigger', { value: t(SCOPE_LABEL_KEYS[current]) })
    : t('search.omni.searchIn.actions');
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            data-search-in-trigger
            aria-label={label}
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-md focus-visible:outline-none',
              mobile ? 'size-9' : 'size-6',
              current === 'everything'
                ? 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:bg-interactive-hover'
                : 'bg-interactive-selection text-interactive-selection-foreground',
            )}
          >
            <Icon name="filter-3" className="size-3.5" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent data-search-in-menu align="end" className="min-w-[180px]">
        {scopes.length > 0 ? (
          <DropdownMenuRadioGroup aria-label={t('search.omni.searchIn.label')} value={current} onValueChange={(next) => { const picked = scopes.find((entry) => entry === next); if (picked) onChange(picked); }}>
            <DropdownMenuLabel>{t('search.omni.searchIn.label')}</DropdownMenuLabel>
            {scopes.map((entry) => <DropdownMenuRadioItem key={entry} data-search-in-option={entry} value={entry} closeOnClick>{t(SCOPE_LABEL_KEYS[entry])}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        ) : null}
        {scopes.length > 0 && actions ? <DropdownMenuSeparator /> : null}
        {actions}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
