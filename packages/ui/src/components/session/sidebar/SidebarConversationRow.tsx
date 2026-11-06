import React from 'react';
import { ConversationResultRow } from '@/components/search/ConversationResultRow';
import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { Button } from '@/components/ui/button';
import { useMessageSearch } from '@/hooks/useMessageSearch';
import type { ConversationResult } from '@/hooks/useConversationSearch';
import type { OmniAuthor, OmniLifecycle, OmniSearchIn } from '@/lib/search/omniQuery';
import { splitSnippet, type MessageSearchRole } from '@/lib/messageSearch';
import { useI18n } from '@/lib/i18n';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export type SidebarSearchPresentation = { query: string; lifecycle: OmniLifecycle; author: OmniAuthor; searchIn?: OmniSearchIn; loadMore: () => void };

const subscribeRuntime = (notify: () => void) => subscribeRuntimeEndpointChanged(() => notify());

function SidebarMessageMatches({ result, query, lifecycle, role, reasoningEnabled, mobile, onOpen }: {
  result: ConversationResult; query: string; lifecycle: OmniLifecycle; role: MessageSearchRole | null; reasoningEnabled: boolean; mobile: boolean; onOpen: (messageId: string) => void;
}): React.ReactNode {
  const { t } = useI18n();
  const matches = useMessageSearch({ query, enabled: true, limit: 20, sessionId: result.sessionId, lifecycle, role, includeReasoning: reasoningEnabled });
  return <div data-sidebar-other-matches={result.sessionId} className="ms-3">
    {'hits' in matches.state ? matches.state.hits.filter((hit) => hit.id !== result.excerpt?.messageId && (!role || hit.role === role) && (reasoningEnabled || hit.role !== 'reasoning')).map((hit) => <button
      key={hit.id} data-sidebar-message-match={hit.id} type="button" dir="auto"
      className={`block w-full truncate text-start text-muted-foreground hover:text-foreground ${mobile ? 'min-h-11' : 'py-1'}`}
      onClick={() => onOpen(hit.id)}><MatchHighlight segments={splitSnippet(hit.snippet)} /></button>) : null}
    {matches.state.status === 'ready' && matches.state.next ? <Button data-sidebar-matches-more variant="link" size="xs" onClick={matches.loadMore} disabled={matches.state.loadingMore}>{t('search.omni.result.loadMore')}</Button> : null}
    {matches.state.status === 'loading' ? <span role="status">{t('search.omni.status.searching')}</span> : matches.state.status === 'error' || (matches.state.status === 'ready' && matches.state.pageError) ? <span role="status">{t('search.omni.status.error')}</span> : null}
    {matches.state.status === 'unavailable' ? <span role="status">{t('search.omni.status.unsupported')}</span> : matches.state.status === 'too-short' ? <span role="status">{t('search.omni.status.tooShort')}</span> : null}
  </div>;
}

export function SidebarSearchMore({ onLoadMore, mobile = false }: { onLoadMore?: () => void; mobile?: boolean }): React.ReactNode {
  const { t } = useI18n();
  return <Button data-sidebar-search-more variant="link" size={mobile ? 'default' : 'xs'} className={mobile ? 'min-h-11' : undefined} onClick={onLoadMore}>{t('search.omni.result.loadMore')}</Button>;
}

export function SidebarConversationRow({ result, meta, mobile = false, depth = 0, search, onOpened }: {
  result: ConversationResult; meta: string; mobile?: boolean; depth?: number; search?: SidebarSearchPresentation; onOpened?: () => void;
}): React.ReactNode {
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const selected = useSessionUIStore((state) => state.currentSessionId === result.sessionId);
  const reasoningEnabled = useUIStore((state) => state.messageSearchReasoningEnabled && state.showReasoningTraces);
  const messageSearchEnabled = useUIStore((state) => state.messageSearchEnabled);
  const runtimeKey = React.useSyncExternalStore(subscribeRuntime, getRuntimeKey, getRuntimeKey);
  const author = search?.author ?? 'any';
  const query = search?.query ?? '';
  const lifecycle = search?.lifecycle ?? 'all';
  const role = author === 'any' || (author === 'reasoning' && !reasoningEnabled) ? null : author;
  const contentAvailable = messageSearchEnabled && search?.searchIn !== 'titles' && !isVSCodeRuntime();
  const expansionKey = JSON.stringify([result.sessionId, query, lifecycle, role, reasoningEnabled, search?.searchIn, contentAvailable, runtimeKey]);
  if (expandedKey !== null && expandedKey !== expansionKey) setExpandedKey(null);
  const showMatches = contentAvailable && Boolean(query.trim()) && expandedKey === expansionKey;
  const excerptAllowed = contentAvailable && (!result.excerpt || ((!role || result.excerpt.role === role) && (reasoningEnabled || result.excerpt.role !== 'reasoning')));
  const visibleResult = excerptAllowed ? result : { ...result, excerpt: null, moreMatches: 0 };
  const open = (messageId: string | null): void => { void openSessionLink(result.sessionId, messageId); onOpened?.(); };
  return <div data-sidebar-conversation={result.sessionId} style={{ paddingInlineStart: depth * 16 }}>
    <ConversationResultRow result={visibleResult} meta={meta} mobile={mobile} selected={selected}
      onOpen={() => open(null)} onOpenExcerpt={() => open(result.excerpt?.messageId ?? null)}
      onShowMoreMatches={visibleResult.moreMatches > 0 && contentAvailable ? () => setExpandedKey(showMatches ? null : expansionKey) : undefined} />
    {showMatches ? <SidebarMessageMatches key={expansionKey} result={visibleResult} query={query} lifecycle={lifecycle} role={role} reasoningEnabled={reasoningEnabled} mobile={mobile} onOpen={open} /> : null}
  </div>;
}
