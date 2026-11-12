import * as React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { type ConversationContentHit, type MessageSearchRole, readMessageSearchStatus, searchConversations } from '@/lib/messageSearch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { ConversationMetadata, MetadataMatch } from '@/lib/search/conversationSearch';
import { rankConversationMetadata } from '@/lib/search/conversationSearch';
import type { MatchRange } from '@/lib/search/matchSegments';
import type { OmniAuthor, OmniLifecycle, OmniSearchIn } from '@/lib/search/omniQuery';
import { useUIStore } from '@/stores/useUIStore';

export type ConversationResult = { sessionId: string; title: string; titleRanges: ReadonlyArray<MatchRange>; directory: string | null; archived: boolean; metadata: MetadataMatch | null; excerpt: { messageId: string; role: MessageSearchRole; snippet: string; createdAt: number } | null; moreMatches: number };
export type ContentSearchStatus =
  | { kind: 'idle' } | { kind: 'off' } | { kind: 'unsupported' } | { kind: 'failed' } | { kind: 'too-short' } | { kind: 'loading' } | { kind: 'ready'; indexing: { done: number; total: number } | null; lifecycleComplete: boolean; hasMore: boolean; pageError?: boolean } | { kind: 'error' };

type Options = { enabled: boolean; text: string; lifecycle: OmniLifecycle; searchIn: OmniSearchIn; author: OmniAuthor; metadataItems: ReadonlyArray<ConversationMetadata>; directories?: readonly string[]; isAdmitted: (directory: string | null) => boolean; contentDebounceMs?: number; pageSize?: number };
type ContentState = { key: string; hits: ConversationContentHit[]; totals: { sessions: number; byDirectory: Record<string, number> } | null; next: string | null; status: ContentSearchStatus };
const idle: ContentState = { key: '', hits: [], totals: null, next: null, status: { kind: 'idle' } };
const EMPTY_MATCHES: MetadataMatch[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_COUNTS = new Map<string, number>();

export function useConversationSearch({ enabled, text, lifecycle, searchIn, author, metadataItems, directories, isAdmitted, contentDebounceMs = 150, pageSize = 20 }: Options) {
  const messageSearchEnabled = useUIStore((state) => state.messageSearchEnabled);
  const messageSearchReasoningEnabled = useUIStore((state) => state.messageSearchReasoningEnabled);
  const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
  const metadata = React.useMemo(() => (enabled ? rankConversationMetadata(metadataItems, text, { titlesOnly: searchIn === 'titles' }) : EMPTY_MATCHES), [enabled, metadataItems, searchIn, text]);
  const metadataIds = React.useMemo(() => (enabled ? metadata.map((match) => match.sessionId) : EMPTY_IDS), [enabled, metadata]);
  const canCount = metadataIds.length <= 200;
  const metadataDirectories = React.useMemo(() => {
    if (!enabled) return EMPTY_COUNTS;
    const itemsById = new Map(metadataItems.map((item) => [item.sessionId, item]));
    return metadataIds.reduce((counts, sessionId) => {
      const directory = itemsById.get(sessionId)?.directory;
      if (directory) counts.set(directory, (counts.get(directory) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
  }, [enabled, metadataIds, metadataItems]);
  const reasoningAvailable = messageSearchReasoningEnabled && showReasoningTraces;
  const normalizedAuthor = author === 'reasoning' && !reasoningAvailable ? 'any' : author;
  const [runtimeKey, setRuntimeKey] = React.useState(getRuntimeKey);
  const [content, setContent] = React.useState<ContentState>(idle);
  // The request key of the next page in flight; `loadingMore` is true only while it is the current key.
  const [pagingKey, setPagingKey] = React.useState<string | null>(null);
  const metadataIdsKey = canCount ? metadataIds.join('\n') : 'too-many';
  const requestKey = `${runtimeKey}\0${enabled}\0${text}\0${lifecycle}\0${searchIn}\0${(directories ?? []).join('\n')}\0${normalizedAuthor}\0${reasoningAvailable}\0${messageSearchEnabled}\0${isVSCodeRuntime()}\0${metadataIdsKey}`;
  const requestKeyRef = React.useRef(requestKey);
  const pagingOperationRef = React.useRef<{ key: string; cursor: string } | null>(null);
  const pageControllerRef = React.useRef<AbortController | null>(null);
  const generationRef = React.useRef(0);
  if (requestKeyRef.current !== requestKey) pagingOperationRef.current = null;
  requestKeyRef.current = requestKey;

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntimeKey(getRuntimeKey())), []);
  React.useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    pageControllerRef.current?.abort();
    pageControllerRef.current = null;
    if (!enabled || !text.trim() || searchIn === 'titles') { setContent({ ...idle, key: requestKey }); return; }
    if (!messageSearchEnabled) { setContent({ ...idle, key: requestKey, status: { kind: 'off' } }); return; }
    if (isVSCodeRuntime()) { setContent({ ...idle, key: requestKey, status: { kind: 'unsupported' } }); return; }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setContent({ ...idle, key: requestKey, status: { kind: 'loading' } });
      const role = normalizedAuthor === 'user' ? 'user' : normalizedAuthor === 'assistant' ? 'assistant' : normalizedAuthor === 'reasoning' ? 'reasoning' : null;
      searchConversations({ query: text, lifecycle, directories, exclude: canCount ? metadataIds : undefined, role, includeReasoning: reasoningAvailable, limit: pageSize, signal: controller.signal }).then(async (result) => {
        if (controller.signal.aborted || generationRef.current !== generation || requestKeyRef.current !== requestKey) return;
        if (result.status === 'query-too-short') { setContent({ ...idle, key: requestKey, status: { kind: 'too-short' } }); return; }
        if (result.status === 'unavailable') {
          try {
            const status = await readMessageSearchStatus(controller.signal);
            if (!controller.signal.aborted && generationRef.current === generation && requestKeyRef.current === requestKey) setContent({ ...idle, key: requestKey, status: { kind: status.state === 'failed' ? 'failed' : 'unsupported' } });
          } catch { if (!controller.signal.aborted && generationRef.current === generation && requestKeyRef.current === requestKey) setContent({ ...idle, key: requestKey, status: { kind: 'error' } }); }
          return;
        }
        const indexing = result.index?.backfill.state === 'running' ? { done: result.index.backfill.done, total: result.index.backfill.total } : null;
        setContent({ key: requestKey, hits: result.hits, totals: result.totals, next: result.next, status: { kind: 'ready', indexing, lifecycleComplete: result.index?.lifecycleComplete ?? true, hasMore: result.next !== null, pageError: false } });
      }).catch(() => { if (!controller.signal.aborted && generationRef.current === generation && requestKeyRef.current === requestKey) setContent({ ...idle, key: requestKey, status: { kind: 'error' } }); });
    }, contentDebounceMs);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      pageControllerRef.current?.abort();
      pageControllerRef.current = null;
      pagingOperationRef.current = null;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [enabled, text, lifecycle, searchIn, normalizedAuthor, directories, messageSearchEnabled, pageSize, requestKey, contentDebounceMs, canCount, metadataIds, reasoningAvailable]);

  // Content from an earlier key is never shown: it goes away on the render that changes the key.
  const shown = content.key === requestKey ? content : idle;
  const contentHitBySession = React.useMemo(() => {
    const bySession = new Map<string, ConversationContentHit>();
    for (const hit of shown.hits) {
      if (!bySession.has(hit.sessionId)) bySession.set(hit.sessionId, hit);
    }
    return bySession;
  }, [shown.hits]);

  const results = React.useMemo(() => {
    if (!enabled) return [];
    const metadataById = new Map(metadata.map((match) => [match.sessionId, match]));
    const sourceById = new Map(metadataItems.map((item) => [item.sessionId, item]));
    const metadataRows = metadata.map((match) => {
      const item = sourceById.get(match.sessionId)!;
      const hit = contentHitBySession.get(item.sessionId);
      return { sessionId: item.sessionId, title: item.title, titleRanges: match.titleRanges, directory: item.directory, archived: item.archived, metadata: match, excerpt: hit ? { messageId: hit.messageId, role: hit.role, snippet: hit.snippet, createdAt: hit.createdAt } : null, moreMatches: Math.max(0, (hit?.matchCount ?? 1) - 1) };
    });
    const contentOnly = new Map<string, ConversationContentHit>();
    for (const hit of shown.hits) {
      if (metadataById.has(hit.sessionId) || contentOnly.has(hit.sessionId) || !isAdmitted(hit.directory)) continue;
      contentOnly.set(hit.sessionId, hit);
    }
    const contentRows = [...contentOnly.values()].map((hit) => ({ sessionId: hit.sessionId, title: hit.sessionTitle, titleRanges: [], directory: hit.directory, archived: hit.archived, metadata: null, excerpt: { messageId: hit.messageId, role: hit.role, snippet: hit.snippet, createdAt: hit.createdAt }, moreMatches: Math.max(0, hit.matchCount - 1) }));
    return [...metadataRows, ...contentRows] satisfies ConversationResult[];
  }, [enabled, shown, contentHitBySession, isAdmitted, metadata, metadataItems]);

  const loadMore = React.useCallback(() => {
    if (content.key !== requestKeyRef.current || content.status.kind !== 'ready' || !content.next) return;
    const key = content.key;
    const cursor = content.next;
    if (pagingOperationRef.current?.key === key && pagingOperationRef.current.cursor === cursor) return;
    const operation = { key, cursor };
    const generation = generationRef.current;
    pagingOperationRef.current = operation;
    const controller = new AbortController();
    pageControllerRef.current = controller;
    const role = normalizedAuthor === 'user' ? 'user' : normalizedAuthor === 'assistant' ? 'assistant' : normalizedAuthor === 'reasoning' ? 'reasoning' : null;
    setPagingKey(key);
    setContent((current) => current.key === key && current.status.kind === 'ready' ? { ...current, status: { ...current.status, pageError: false } } : current);
    const failPage = () => {
      if (controller.signal.aborted || generationRef.current !== generation || requestKeyRef.current !== key) return;
      setContent((current) => current.key === key && current.status.kind === 'ready' ? { ...current, status: { ...current.status, pageError: true } } : current);
    };
    const finish = () => {
      if (pagingOperationRef.current !== operation) return;
      pagingOperationRef.current = null;
      if (pageControllerRef.current === controller) pageControllerRef.current = null;
      setPagingKey((current) => (current === key ? null : current));
    };
    // A failed or unusable page keeps what is loaded and the cursor, so the same page can be asked again.
    void searchConversations({ query: text, lifecycle, directories, exclude: canCount ? metadataIds : undefined, role, includeReasoning: reasoningAvailable, before: content.next, limit: pageSize, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || generationRef.current !== generation || requestKeyRef.current !== key) return;
      if (result.status !== 'ok') { failPage(); return; }
      setContent((current) => current.key === key ? { ...current, hits: [...current.hits, ...result.hits], next: result.next, status: current.status.kind === 'ready' ? { ...current.status, hasMore: result.next !== null, pageError: false } : current.status } : current);
    }, failPage).finally(finish);
  }, [canCount, content, directories, lifecycle, metadataIds, normalizedAuthor, pageSize, reasoningAvailable, text]);

  const contentReady = shown.status.kind === 'ready';
  // An unscoped request counts the whole index; only directories whose rows can show count here.
  const admittedContentTotals = contentReady && canCount && shown.totals
    ? Object.entries(shown.totals.byDirectory).filter(([directory]) => isAdmitted(directory))
    : null;
  const totalCount = !enabled ? 0 : contentReady
    ? (admittedContentTotals ? admittedContentTotals.reduce((sum, [, count]) => sum + count, metadata.length) : null)
    : metadata.length;
  const contentDirectoryCounts = admittedContentTotals
    ? admittedContentTotals.map(([directory, count]): [string, number] => [directory, (metadataDirectories.get(directory) ?? 0) + count])
    : null;
  const countsByDirectory = !enabled ? EMPTY_COUNTS : contentDirectoryCounts ? new Map([...metadataDirectories, ...contentDirectoryCounts]) : contentReady ? null : metadataDirectories;
  return { results, contentStatus: shown.status, loadMore, loadingMore: pagingKey === requestKey, metadataCount: metadata.length, totalCount, countsByDirectory };
}
