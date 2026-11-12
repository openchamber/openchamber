import React from 'react';
import { ConversationResultRow } from '@/components/search/ConversationResultRow';
import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { Icon } from '@/components/icon/Icon';
import { RowMarkTooltip } from './sessions/RowMarkTooltip';
import { TimelineProjectIcon } from './sessions/SessionTimelineRowBody';
import { formatSessionCompactDateLabel } from './utils';
import type { SearchResultSection } from './sessionSidebarRowModel';
import { Button } from '@/components/ui/button';
import { useMessageSearch } from '@/hooks/useMessageSearch';
import type { ConversationResult } from '@/hooks/useConversationSearch';
import type { OmniAuthor, OmniSearchIn } from '@/lib/search/omniQuery';
import { leadWithMatch, splitSnippet, type MessageSearchRole } from '@/lib/messageSearch';
import { useI18n } from '@/lib/i18n';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { requestReasoningReveal } from '@/components/chat/search/reasoningReveal';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { ConversationResultContext } from '@/components/search/conversationResultContext';

export type SidebarSearchPresentation = { query: string; author: OmniAuthor; searchIn?: OmniSearchIn; loadMore: (section: SearchResultSection) => void; showMore: (section: SearchResultSection) => void };

const subscribeRuntime = (notify: () => void) => subscribeRuntimeEndpointChanged(() => notify());

function SidebarMessageMatches({ result, query, role, reasoningEnabled, mobile, onOpen }: {
  result: ConversationResult; query: string; role: MessageSearchRole | null; reasoningEnabled: boolean; mobile: boolean; onOpen: (messageId: string, role: MessageSearchRole) => void;
}): React.ReactNode {
  const { t } = useI18n();
  const matches = useMessageSearch({ query, enabled: true, limit: 20, sessionId: result.sessionId, lifecycle: 'all', role, includeReasoning: reasoningEnabled });
  return <div data-sidebar-other-matches={result.sessionId} className="ms-3">
    {'hits' in matches.state ? matches.state.hits.filter((hit) => hit.id !== result.excerpt?.messageId && (!role || hit.role === role) && (reasoningEnabled || hit.role !== 'reasoning')).map((hit) => <button
      key={hit.id} data-sidebar-message-match={hit.id} type="button" dir="auto"
      className={`block w-full truncate text-start text-muted-foreground hover:text-foreground ${mobile ? 'min-h-11' : 'py-1'}`}
      onClick={() => onOpen(hit.id, hit.role)}><MatchHighlight segments={leadWithMatch(splitSnippet(hit.snippet))} /></button>) : null}
    {matches.state.status === 'ready' && matches.state.next ? <Button data-sidebar-matches-more variant="link" size="xs" onClick={matches.loadMore} disabled={matches.state.loadingMore}>{t('search.omni.result.loadMore')}</Button> : null}
    {matches.state.status === 'loading' ? <span role="status">{t('search.omni.status.searching')}</span> : matches.state.status === 'error' || (matches.state.status === 'ready' && matches.state.pageError) ? <span role="status">{t('search.omni.status.error')}</span> : null}
    {matches.state.status === 'unavailable' ? <span role="status">{t('search.omni.status.unsupported')}</span> : matches.state.status === 'too-short' ? <span role="status">{t('search.omni.status.tooShort')}</span> : null}
  </div>;
}

export function SidebarSearchMore({ onLoadMore, mobile = false }: { onLoadMore?: () => void; mobile?: boolean }): React.ReactNode {
  const { t } = useI18n();
  return <Button data-sidebar-search-more variant="link" size={mobile ? 'default' : 'xs'} className={mobile ? 'min-h-11' : undefined} onClick={onLoadMore}>{t('search.omni.result.loadMore')}</Button>;
}

/** The caption over a search's archived matches. */
export function SidebarSearchArchivedCaption(): React.ReactNode {
  const { t } = useI18n();
  return <div data-sidebar-search-archived className="px-2 pt-2 pb-1 typography-ui-label font-medium text-muted-foreground">{t('search.omni.result.archivedTag')}</div>;
}

export function SidebarSearchShowMore({ section, hidden, onShow, mobile = false }: { section: SearchResultSection; hidden: number; onShow?: (section: SearchResultSection) => void; mobile?: boolean }): React.ReactNode {
  const { t } = useI18n();
  return <Button data-sidebar-search-show-more={section} variant="link" size={mobile ? 'default' : 'xs'} className={mobile ? 'min-h-11' : undefined} onClick={() => onShow?.(section)}>{t('search.omni.result.showArchived', { count: hidden })}</Button>;
}

// Where the conversation lives, as the one mark the eye scans down the list:
// its project's icon, a folder for a directory outside every project, a chat
// bubble for a chat.
function ResultLocationMark({ context }: { context: ConversationResultContext }): React.ReactNode {
  const { t } = useI18n();
  if (context.project) return <TimelineProjectIcon project={context.project} label={context.project.label} />;
  if (context.folderLabel) return <RowMarkTooltip label={context.folderLabel}><span role="img" aria-label={context.folderLabel} className="inline-flex size-3 shrink-0 items-center justify-center"><Icon name="folder" className="size-3 text-muted-foreground" /></span></RowMarkTooltip>;
  return <span role="img" aria-label={t('sessions.sidebar.activity.chatsTitle')} className="inline-flex size-3 shrink-0 items-center justify-center"><Icon name="chat-4" className="size-3 text-muted-foreground" /></span>;
}

export function SidebarConversationRow({ result, context, mobile = false, search, onOpened }: {
  result: ConversationResult; context: ConversationResultContext; mobile?: boolean; search?: SidebarSearchPresentation; onOpened?: () => void;
}): React.ReactNode {
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const selected = useSessionUIStore((state) => state.currentSessionId === result.sessionId);
  const reasoningEnabled = useUIStore((state) => state.messageSearchReasoningEnabled && state.showReasoningTraces);
  const messageSearchEnabled = useUIStore((state) => state.messageSearchEnabled);
  const runtimeKey = React.useSyncExternalStore(subscribeRuntime, getRuntimeKey, getRuntimeKey);
  const author = search?.author ?? 'any';
  const query = search?.query ?? '';
  const role = author === 'any' || (author === 'reasoning' && !reasoningEnabled) ? null : author;
  const contentAvailable = messageSearchEnabled && search?.searchIn !== 'titles' && !isVSCodeRuntime();
  const expansionKey = JSON.stringify([result.sessionId, query, role, reasoningEnabled, search?.searchIn, contentAvailable, runtimeKey]);
  if (expandedKey !== null && expandedKey !== expansionKey) setExpandedKey(null);
  const showMatches = contentAvailable && Boolean(query.trim()) && expandedKey === expansionKey;
  const excerptAllowed = contentAvailable && (!result.excerpt || ((!role || result.excerpt.role === role) && (reasoningEnabled || result.excerpt.role !== 'reasoning')));
  const visibleResult = excerptAllowed ? result : { ...result, excerpt: null, moreMatches: 0 };
  const open = (messageId: string | null, role?: MessageSearchRole): void => {
    requestReasoningReveal(messageId && role === 'reasoning' ? messageId : null);
    void openSessionLink(result.sessionId, messageId);
    onOpened?.();
  };
  return <div data-sidebar-conversation={result.sessionId}>
    <ConversationResultRow result={visibleResult} mobile={mobile} selected={selected}
      leading={<ResultLocationMark context={context} />}
      age={result.updatedAt ? formatSessionCompactDateLabel(result.updatedAt) : undefined}
      onOpen={() => open(null)} onOpenExcerpt={() => open(result.excerpt?.messageId ?? null, result.excerpt?.role)}
      onShowMoreMatches={visibleResult.moreMatches > 0 && contentAvailable ? () => setExpandedKey(showMatches ? null : expansionKey) : undefined} />
    {showMatches ? <SidebarMessageMatches key={expansionKey} result={visibleResult} query={query} role={role} reasoningEnabled={reasoningEnabled} mobile={mobile} onOpen={open} /> : null}
  </div>;
}
