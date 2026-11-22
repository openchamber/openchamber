import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ContentSearchStatus } from '@/hooks/useConversationSearch';
import { searchScopeQuery, type SearchScope } from '@/lib/search/omniQuery';
import { useSearchFailureText } from './searchStatusText';

export function SearchStatusMark({ status, scope = 'everything' }: { status: ContentSearchStatus; scope?: SearchScope }): React.ReactNode {
  const text = useSearchFailureText(status, searchScopeQuery(scope).searchIn === 'messages');
  if (!text) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-search-status="error" role="status" aria-label={text} className="inline-flex size-6 shrink-0 items-center justify-center">
          <Icon name="error-warning" className="size-3.5 text-status-error" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>{text}</TooltipContent>
    </Tooltip>
  );
}
