import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useI18n } from '@/lib/i18n';
import { isSearchableQuery, searchMessages, type MessageSearchHit } from '@/lib/messageSearch';
import { requestMessageFocus } from '@/lib/router/messageFocus';
import { useUIStore } from '@/stores/useUIStore';

import { findTermRanges, paintSearchHighlights, toHighlightTerms } from './chatSearchHighlight';
import { requestReasoningReveal } from './reasoningReveal';

// Hits come from the server's index for this session only, oldest first, so
// messages the timeline has not loaded yet are found too; moving to one goes
// through the message-link mechanism, which loads older history itself.
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

type SearchState =
  | { status: 'idle' }
  | { status: 'too-short' }
  | { status: 'loading' }
  | { status: 'ready'; hits: MessageSearchHit[] }
  | { status: 'error' }
  | { status: 'unavailable' };

const loadAllHits = async (query: string, sessionId: string, includeReasoning: boolean, signal: AbortSignal): Promise<SearchState> => {
  const hits: MessageSearchHit[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await searchMessages({ query, sessionId, includeReasoning, order: 'asc', limit: PAGE_SIZE, before, signal });
    if (result.status === 'unavailable') return { status: 'unavailable' };
    if (result.status === 'query-too-short') return { status: 'too-short' };
    hits.push(...result.hits);
    if (!result.next) break;
    before = result.next;
  }
  return { status: 'ready', hits };
};

export const ChatSearchBar: React.FC<{
  sessionId: string;
  scrollNode: HTMLElement | null;
  /** Bumped by every Cmd+F: focus and select the query again. */
  focusRequest: number;
  onClose: () => void;
}> = ({ sessionId, scrollNode, focusRequest, onClose }) => {
  const { t } = useI18n();
  // Hidden reasoning is not searched: its hits would lead nowhere visible.
  const includeReasoning = useUIStore((state) => state.showReasoningTraces);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 200).trim();
  const [state, setState] = React.useState<SearchState>({ status: 'idle' });
  const [current, setCurrent] = React.useState(-1);
  const hits = state.status === 'ready' ? state.hits : [];
  const currentHit = current >= 0 ? hits[current] ?? null : null;

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  React.useEffect(() => {
    if (!debouncedQuery) {
      setState({ status: 'idle' });
      setCurrent(-1);
      return;
    }
    if (!isSearchableQuery(debouncedQuery)) {
      setState({ status: 'too-short' });
      setCurrent(-1);
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    loadAllHits(debouncedQuery, sessionId, includeReasoning, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setState(next);
        // Start at the newest match: the reader is usually near the end.
        setCurrent(next.status === 'ready' ? next.hits.length - 1 : -1);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [debouncedQuery, includeReasoning, sessionId]);

  // Moving to a hit is a message link: shown where links land, loading older
  // history when the message is not in the loaded window. A hit in reasoning
  // opens the folds it sits behind first.
  React.useEffect(() => {
    if (!currentHit) return;
    requestReasoningReveal(currentHit.role === 'reasoning' ? currentHit.id : null);
    requestMessageFocus(sessionId, currentHit.id);
  }, [currentHit, sessionId]);

  // Paint every visible occurrence, the current hit's stronger; repaint as
  // rows mount, unmount or re-render. A reasoning hit paints its reasoning
  // block, which sorted mode may draw inside another message.
  const hitIdsKey = hits.map((hit) => `${hit.role === 'reasoning' ? 'r' : 'm'}:${hit.id}`).join(' ');
  React.useEffect(() => {
    const terms = toHighlightTerms(debouncedQuery);
    if (!scrollNode || terms.length === 0 || hits.length === 0) {
      paintSearchHighlights([], []);
      return;
    }
    const hitKeys = new Set(hitIdsKey.split(' '));
    const currentKey = currentHit ? `${currentHit.role === 'reasoning' ? 'r' : 'm'}:${currentHit.id}` : null;
    let frame: number | null = null;
    const repaint = () => {
      frame = null;
      const all: Range[] = [];
      const emphasized: Range[] = [];
      for (const root of scrollNode.querySelectorAll('[data-message-id], [data-reasoning-message-id]')) {
        const messageId = root.getAttribute('data-message-id');
        const key = messageId ? `m:${messageId}` : `r:${root.getAttribute('data-reasoning-message-id') ?? ''}`;
        if (!hitKeys.has(key)) continue;
        const ranges = findTermRanges(root, terms);
        all.push(...ranges);
        if (key === currentKey) emphasized.push(...ranges);
      }
      paintSearchHighlights(all, emphasized);
    };
    const observer = new MutationObserver(() => {
      if (frame === null) frame = window.requestAnimationFrame(repaint);
    });
    observer.observe(scrollNode, { childList: true, subtree: true, characterData: true });
    repaint();
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
    // `hitIdsKey` stands for `hits`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHit?.id, currentHit?.role, debouncedQuery, hitIdsKey, scrollNode]);

  React.useEffect(() => () => {
    paintSearchHighlights([], []);
    requestReasoningReveal(null);
  }, []);

  const step = React.useCallback((delta: number) => {
    if (hits.length === 0) return;
    setCurrent((index) => (index + delta + hits.length) % hits.length);
  }, [hits.length]);

  const status = state.status === 'ready'
    ? hits.length === 0 ? t('chat.search.noResults') : t('chat.search.position', { current: current + 1, total: hits.length })
    : state.status === 'loading' ? t('chat.search.searching')
      : state.status === 'too-short' ? t('chat.search.tooShort')
        : state.status === 'error' ? t('chat.search.error')
          : state.status === 'unavailable' ? t('chat.search.unavailable')
            : '';

  return (
    <div
      role="search"
      className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-[var(--surface-elevated)] py-1 pl-2.5 pr-1 shadow-md"
    >
      <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={t('chat.search.placeholder')}
        aria-label={t('chat.search.placeholder')}
        className="h-7 w-48 min-w-0 bg-transparent typography-meta text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span className="min-w-[4.5rem] shrink-0 text-right typography-micro text-muted-foreground" role="status" aria-live="polite">{status}</span>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={hits.length === 0} onClick={() => step(-1)} aria-label={t('chat.search.previous')}>
        <Icon name="arrow-up-s" className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={hits.length === 0} onClick={() => step(1)} aria-label={t('chat.search.next')}>
        <Icon name="arrow-down-s" className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label={t('chat.search.close')}>
        <Icon name="close" className="h-4 w-4" />
      </Button>
    </div>
  );
};
