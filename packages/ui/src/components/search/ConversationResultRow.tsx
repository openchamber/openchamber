import React from 'react';

import { Button } from '@/components/ui/button';
import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { splitSnippet } from '@/lib/messageSearch';
import { matchSegments } from '@/lib/search/matchSegments';
import { useI18n } from '@/lib/i18n';
import type { ConversationResult } from '@/hooks/useConversationSearch';

export const ConversationResultRow: React.FC<{ result: ConversationResult; meta: string; selected?: boolean; mobile?: boolean; trailing?: React.ReactNode; onOpen: () => void; onOpenExcerpt: () => void; onShowMoreMatches?: () => void }> = ({ result, meta, selected = false, mobile = false, trailing, onOpen, onOpenExcerpt, onShowMoreMatches }) => {
  const { t } = useI18n();
  const authorKey = result.excerpt?.role === 'user' ? 'search.omni.result.byYou' : result.excerpt?.role === 'reasoning' ? 'search.omni.result.inReasoning' : 'search.omni.result.byAgent';
  return <div data-conversation-result={result.sessionId} className={`flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 ${selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover'}`}>
    <div className="min-w-0 flex-1">
      <button data-conversation-title-action type="button" onClick={onOpen} className={`flex w-full min-w-0 gap-1 overflow-hidden text-start ${mobile ? 'min-h-11 items-center py-1' : 'items-baseline'}`}>
        <span data-conversation-title dir="auto" className="min-w-0 truncate typography-ui-label"><MatchHighlight segments={matchSegments(result.title, result.titleRanges)} /></span>
        {result.archived ? <span data-conversation-archived className="shrink-0 rounded oc-tile-inset px-1 text-muted-foreground typography-micro">{t('search.omni.result.archivedTag')}</span> : null}
        <span data-conversation-meta className="min-w-0 truncate whitespace-nowrap text-muted-foreground">· {meta}</span>
      </button>
      {result.excerpt ? <button data-conversation-excerpt-action type="button" onClick={onOpenExcerpt} className={`mt-0.5 block w-full min-w-0 overflow-hidden text-start text-muted-foreground ${mobile ? 'min-h-11 line-clamp-2 py-1' : 'truncate'}`}><span>{t(authorKey)} · </span><MatchHighlight segments={splitSnippet(result.excerpt.snippet)} /></button> : null}
      {result.moreMatches > 0 && onShowMoreMatches ? <Button data-conversation-more-matches variant="link" size="xs" className="h-auto px-0" onClick={onShowMoreMatches} aria-label={t('search.omni.result.moreMatchesAria', { title: result.title })}>{t(result.moreMatches === 1 ? 'search.omni.result.moreMatches.one' : 'search.omni.result.moreMatches.other', { count: result.moreMatches })}</Button> : null}
    </div>
    {trailing}
  </div>;
};
