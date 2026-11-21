import React from 'react';

import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { leadWithMatch, splitSnippet } from '@/lib/messageSearch';
import { matchSegments } from '@/lib/search/matchSegments';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ConversationResult } from '@/hooks/useConversationSearch';
import { SearchMetaList } from './SearchMetaList';
import { conversationContextItems } from './conversationContextItems';
import type { ConversationResultContext } from './conversationResultContext';

type Props = {
  result: ConversationResult;
  leading?: React.ReactNode;
  age?: string;
  context?: ConversationResultContext;
  selected?: boolean;
  mobile?: boolean;
  trailing?: React.ReactNode;
  onOpen: () => void;
  onOpenExcerpt: () => void;
  onShowMoreMatches?: () => void;
};

export const ConversationResultRow: React.FC<Props> = ({ result, leading, age, context, selected = false, mobile = false, trailing, onOpen, onOpenExcerpt, onShowMoreMatches }) => {
  const { t } = useI18n();
  const authorKey = result.excerpt?.role === 'user' ? 'search.omni.result.byYou' : result.excerpt?.role === 'reasoning' ? 'search.omni.result.inReasoning' : 'search.omni.result.byAgent';
  const contextItems = context ? conversationContextItems(context, {
    project: t('search.omni.result.context.project'),
    folder: t('search.omni.result.context.folder'),
    branch: t('search.omni.result.context.branch'),
    space: t('search.omni.result.context.space'),
  }) : [];
  return <div data-conversation-result={result.sessionId} className={cn('flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5', selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover')}>
    <div className="min-w-0 flex-1">
      <button data-conversation-title-action type="button" onClick={onOpen} className={cn('flex w-full min-w-0 flex-col overflow-hidden text-start', mobile && (result.excerpt ? 'min-h-9 justify-end pb-0.5' : 'min-h-11 justify-center py-1'))}>
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {leading}
          <span data-conversation-title dir="auto" className="min-w-0 flex-1 truncate typography-ui-label oc-ui-start-align"><MatchHighlight segments={matchSegments(result.title, result.titleRanges)} /></span>
          {age ? <span data-conversation-age className="shrink-0 typography-micro tabular-nums text-muted-foreground">{age}</span> : null}
        </span>
        <SearchMetaList items={contextItems} className={cn('mt-px text-muted-foreground', mobile ? 'typography-meta' : 'typography-micro')} />
      </button>
      {result.excerpt ? <div className={cn('flex min-w-0 gap-1.5 typography-meta text-muted-foreground', mobile ? 'items-start' : 'items-baseline')}>
        <button data-conversation-excerpt-action type="button" onClick={onOpenExcerpt} className={cn('min-w-0 flex-1 overflow-hidden text-start hover:text-foreground', mobile ? 'min-h-9 line-clamp-2 pb-1.5' : 'truncate')}>
          <span data-conversation-excerpt-author className="me-1 font-medium">{t('search.omni.result.authorPrefix', { author: t(authorKey) })}</span>
          <MatchHighlight segments={leadWithMatch(splitSnippet(result.excerpt.snippet), mobile ? 48 : 20)} />
        </button>
        {result.moreMatches > 0 && onShowMoreMatches ? <button data-conversation-more-matches type="button" onClick={onShowMoreMatches} aria-label={t('search.omni.result.moreMatchesAria', { title: result.title })} className={cn('shrink-0 tabular-nums hover:text-foreground', mobile && 'min-h-9 min-w-9')}>
          {t('search.omni.result.moreMatchesCount', { count: result.moreMatches })}
        </button> : null}
      </div> : null}
    </div>
    {trailing}
  </div>;
};
