import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { isSearchableQuery, searchMessages, type MessageSearchHit } from '@/lib/messageSearch';
import { useUIStore } from '@/stores/useUIStore';

import { findTermRanges, paintSearchHighlights, toHighlightTerms } from './chatSearchHighlight';
import { requestReasoningReveal } from './reasoningReveal';
import { rowPartName, searchTargetKey, showSearchMatch, type MatchLocator, type MatchPlace, type SearchTarget } from './searchMatchNavigation';

const PAGE_SIZE = 200;
const MAX_PAGES = 5;

type SearchState =
  | { status: 'idle' }
  | { status: 'too-short' }
  | { status: 'loading' }
  | { status: 'ready'; hits: MessageSearchHit[]; terms: string[] }
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
  return { status: 'ready', hits, terms: toHighlightTerms(query) };
};

type Occurrence = { readonly hit: MessageSearchHit; readonly index: number; readonly count: number };

const toOccurrences = (hits: readonly MessageSearchHit[]): Occurrence[] => hits.flatMap((hit) => {
  const count = Math.max(1, hit.matchCount ?? 1);
  return Array.from({ length: count }, (_, index) => ({ hit, index, count }));
});

const hitTarget = (hit: MessageSearchHit): SearchTarget => ({ messageId: hit.id, reasoning: hit.role === 'reasoning' });

const placeFor = (occurrence: Occurrence, previous: ShownMatch | null): MatchPlace => {
  const key = searchTargetKey(hitTarget(occurrence.hit));
  const { index, count } = occurrence;
  if (previous?.locator && previous.key === key) {
    if (previous.index === index) return { kind: 'shown', index, locator: previous.locator };
    if (Math.abs(previous.index - index) === 1) {
      return { kind: index > previous.index ? 'next' : 'previous', index, from: previous.locator };
    }
  }
  return { kind: count > 1 && index === count - 1 ? 'last' : 'index', index };
};

type ShownMatch = { readonly key: string; readonly index: number; readonly locator: MatchLocator | null; readonly landing: boolean };

const SearchAction: React.FC<{
  label: string;
  icon: IconName;
  disabled?: boolean;
  onClick: () => void;
}> = ({ label, icon, disabled, onClick }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="inline-flex">
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={disabled} onClick={onClick} aria-label={label}>
          <Icon name={icon} className="h-4 w-4" />
        </Button>
      </span>
    </TooltipTrigger>
    <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
  </Tooltip>
);

export const ChatSearchBar: React.FC<{
  sessionId: string;
  scrollNode: HTMLElement | null;
  focusRequest: number;
  onTakeViewport: () => void;
  onClose: () => void;
}> = ({ sessionId, scrollNode, focusRequest, onTakeViewport, onClose }) => {
  const { t } = useI18n();
  const includeReasoning = useUIStore((state) => state.showReasoningTraces);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 200).trim();
  const [state, setState] = React.useState<SearchState>({ status: 'idle' });
  const [current, setCurrent] = React.useState(-1);
  const [shownLocator, setShownLocator] = React.useState<MatchLocator | null>(null);
  const [stepSeq, setStepSeq] = React.useState(0);
  const shownRef = React.useRef<ShownMatch | null>(null);
  const queuedStepRef = React.useRef(0);
  const onTakeViewportRef = React.useRef(onTakeViewport);
  onTakeViewportRef.current = onTakeViewport;
  const hits = React.useMemo(() => (state.status === 'ready' ? state.hits : []), [state]);
  const occurrences = React.useMemo(() => toOccurrences(hits), [hits]);
  const terms = state.status === 'ready' ? state.terms : null;
  const currentOccurrence = current >= 0 ? occurrences[current] ?? null : null;

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
        shownRef.current = null;
        queuedStepRef.current = 0;
        setState(next);
        setCurrent(next.status === 'ready' ? toOccurrences(next.hits).length - 1 : -1);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [debouncedQuery, includeReasoning, sessionId]);

  React.useEffect(() => {
    if (!currentOccurrence || !scrollNode || !terms) return;
    const target = hitTarget(currentOccurrence.hit);
    const key = searchTargetKey(target);
    const { index } = currentOccurrence;
    const place = placeFor(currentOccurrence, shownRef.current);
    shownRef.current = { key, index, locator: null, landing: true };
    const total = occurrences.length;
    const ended = (locator: MatchLocator | null) => {
      shownRef.current = { key, index, locator, landing: false };
      setShownLocator(locator);
    };
    const landed = (locator: MatchLocator | null) => {
      ended(locator);
      const step = Math.sign(queuedStepRef.current);
      queuedStepRef.current = total > 1 ? queuedStepRef.current - step : 0;
      if (step === 0) return;
      setStepSeq((at) => at + 1);
      setCurrent((at) => (at + step + total) % total);
    };
    setShownLocator(null);
    requestReasoningReveal(target.reasoning ? target.messageId : null);
    const cancel = showSearchMatch({
      scrollNode,
      sessionId,
      target,
      terms,
      place,
      takeViewport: () => onTakeViewportRef.current(),
      onShown: landed,
      onNotFound: () => landed(null),
      onInterrupted: () => {
        queuedStepRef.current = 0;
        ended(null);
      },
    });
    return () => {
      cancel();
      if (shownRef.current?.landing) shownRef.current = { ...shownRef.current, landing: false };
    };
  }, [currentOccurrence, occurrences.length, scrollNode, sessionId, terms, stepSeq]);

  const hitIdsKey = hits.map((hit) => searchTargetKey(hitTarget(hit))).join(' ');
  React.useEffect(() => {
    const terms = toHighlightTerms(debouncedQuery);
    if (!scrollNode || terms.length === 0 || hits.length === 0) {
      paintSearchHighlights([], []);
      return;
    }
    const hitKeys = new Set(hitIdsKey.split(' '));
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
        if (shownLocator?.key !== key || root.hasAttribute('data-message-hoisted')) continue;
        if (rowPartName(root) !== shownLocator.part) continue;
        const shown = ranges[shownLocator.order];
        if (shown) emphasized.push(shown);
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, hitIdsKey, scrollNode, shownLocator]);

  React.useEffect(() => () => {
    paintSearchHighlights([], []);
    requestReasoningReveal(null);
  }, []);

  const step = React.useCallback((delta: number) => {
    if (occurrences.length === 0) return;
    if (shownRef.current?.landing) {
      queuedStepRef.current += delta;
      return;
    }
    setStepSeq((at) => at + 1);
    setCurrent((index) => (index + delta + occurrences.length) % occurrences.length);
  }, [occurrences.length]);

  const status = state.status === 'ready'
    ? hits.length === 0 ? t('chat.search.noResults') : t('chat.search.position', { current: current + 1, total: occurrences.length })
    : state.status === 'loading' ? t('chat.search.searching')
      : state.status === 'too-short' ? t('chat.search.tooShort')
        : state.status === 'error' ? t('chat.search.error')
          : state.status === 'unavailable' ? t('chat.search.unavailable')
            : '';

  return (
    <div
      role="search"
      className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-[var(--surface-elevated)] py-1 ps-2.5 pe-1 shadow-md"
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
      <span className="min-w-[4.5rem] shrink-0 text-end typography-micro text-muted-foreground" role="status" aria-live="polite">{status}</span>
      <SearchAction label={t('chat.search.previous')} icon="arrow-up-s" disabled={hits.length === 0} onClick={() => step(-1)} />
      <SearchAction label={t('chat.search.next')} icon="arrow-down-s" disabled={hits.length === 0} onClick={() => step(1)} />
      <SearchAction label={t('chat.search.close')} icon="close" onClick={onClose} />
    </div>
  );
};
