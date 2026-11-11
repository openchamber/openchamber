import React from 'react';

import { Button } from '@/components/ui/button';
import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { splitSnippet } from '@/lib/messageSearch';
import { matchSegments } from '@/lib/search/matchSegments';
import { useI18n } from '@/lib/i18n';
import type { ConversationResult } from '@/hooks/useConversationSearch';
import { SearchMetaList } from './SearchMetaList';
import { conversationContextItems } from './conversationContextItems';
import type { ConversationResultContext } from './conversationResultContext';

export const ConversationResultRow: React.FC<{ result: ConversationResult; context: ConversationResultContext; selected?: boolean; mobile?: boolean; trailing?: React.ReactNode; onOpen: () => void; onOpenExcerpt: () => void; onShowMoreMatches?: () => void }> = ({ result, context, selected = false, mobile = false, trailing, onOpen, onOpenExcerpt, onShowMoreMatches }) => {
  const { t } = useI18n();
  const authorKey = result.excerpt?.role === 'user' ? 'search.omni.result.byYou' : result.excerpt?.role === 'reasoning' ? 'search.omni.result.inReasoning' : 'search.omni.result.byAgent';
  const contextItems = conversationContextItems(context, {
    project: t('search.omni.result.context.project'),
    folder: t('search.omni.result.context.folder'),
    branch: t('search.omni.result.context.branch'),
    space: t('search.omni.result.context.space'),
  });
  return <div data-conversation-result={result.sessionId} className={`flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 ${selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover'}`}>
    <div className="min-w-0 flex-1">
      <button data-conversation-title-action type="button" onClick={onOpen} className={`flex w-full min-w-0 flex-col overflow-hidden text-start ${mobile ? 'min-h-11 justify-center py-1' : ''}`}>
        <span className="flex min-w-0 items-baseline gap-1">
          <span data-conversation-title dir="auto" className="min-w-0 truncate typography-ui-label"><MatchHighlight segments={matchSegments(result.title, result.titleRanges)} /></span>
          {result.archived ? <span data-conversation-archived className="shrink-0 rounded oc-tile-inset px-1 text-muted-foreground typography-micro">{t('search.omni.result.archivedTag')}</span> : null}
        </span>
        <SearchMetaList items={contextItems} className={`mt-px text-muted-foreground ${mobile ? 'typography-meta' : 'typography-micro'}`} />
      </button>
      {result.excerpt ? <button data-conversation-excerpt-action type="button" onClick={onOpenExcerpt} className={`mt-0.5 block w-full min-w-0 overflow-hidden text-start text-muted-foreground ${mobile ? 'min-h-11 line-clamp-2 py-1' : 'truncate'}`}><span data-conversation-excerpt-author className="me-1.5 inline-block shrink-0 rounded oc-tile-inset px-1 align-baseline typography-micro text-muted-foreground">{t(authorKey)}</span><MatchHighlight segments={splitSnippet(result.excerpt.snippet)} /></button> : null}
      {result.moreMatches > 0 && onShowMoreMatches ? <Button data-conversation-more-matches variant="link" size="xs" className="h-auto px-0" onClick={onShowMoreMatches} aria-label={t('search.omni.result.moreMatchesAria', { title: result.title })}>{t(result.moreMatches === 1 ? 'search.omni.result.moreMatches.one' : 'search.omni.result.moreMatches.other', { count: result.moreMatches })}</Button> : null}
    </div>
    {trailing}
  </div>;
};
