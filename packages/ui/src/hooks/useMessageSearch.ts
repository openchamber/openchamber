import React from 'react';

import {
  isSearchableQuery,
  searchMessages,
  type MessageSearchHit,
  type MessageSearchIndexStatus,
  type MessageSearchRole,
} from '@/lib/messageSearch';

type MessageSearchState =
  | { status: 'idle' }
  | { status: 'too-short' }
  | { status: 'unavailable' }
  | { status: 'loading'; hits: MessageSearchHit[] }
  | { status: 'ready'; hits: MessageSearchHit[]; next: string | null; index: MessageSearchIndexStatus | null; loadingMore: boolean }
  | { status: 'error'; hits: MessageSearchHit[] };

type MessageSearchOptions = {
  query: string;
  enabled: boolean;
  limit: number;
  sessionId?: string | null;
  directories?: readonly string[];
  role?: MessageSearchRole | null;
  includeReasoning?: boolean;
  order?: 'asc' | 'desc';
};

const IDLE: MessageSearchState = { status: 'idle' };

/**
 * One search at a time: a new query or filter aborts the request in flight,
 * and an answer to anything but the current request is dropped. The hits of
 * the previous query stay visible while the next one loads, so the list does
 * not flash empty between keystrokes.
 */
export const useMessageSearch = ({ query, enabled, limit, sessionId = null, directories, role = null, includeReasoning = true, order = 'desc' }: MessageSearchOptions) => {
  const [state, setState] = React.useState<MessageSearchState>(IDLE);
  const directoriesKey = (directories ?? []).join('\n');
  const requestKey = `${query}\u0000${sessionId ?? ''}\u0000${directoriesKey}\u0000${role ?? ''}\u0000${order}\u0000${limit}\u0000${includeReasoning}`;
  const requestKeyRef = React.useRef(requestKey);
  requestKeyRef.current = requestKey;
  const directoriesRef = React.useRef(directories);
  directoriesRef.current = directories;

  React.useEffect(() => {
    if (!enabled || !query.trim()) {
      setState(IDLE);
      return;
    }
    if (!isSearchableQuery(query)) {
      setState({ status: 'too-short' });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ status: 'loading', hits: 'hits' in previous ? previous.hits : [] }));
    searchMessages({ query, sessionId, directories: directoriesRef.current, role, includeReasoning, order, limit, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.status === 'ok') setState({ status: 'ready', hits: result.hits, next: result.next, index: result.index, loadingMore: false });
        else if (result.status === 'query-too-short') setState({ status: 'too-short' });
        else setState({ status: 'unavailable' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error', hits: [] });
      });
    return () => controller.abort();
    // `requestKey` stands for query, filters and page size together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, requestKey]);

  const stateRef = React.useRef(state);
  stateRef.current = state;

  const loadMore = React.useCallback(() => {
    const current = stateRef.current;
    if (current.status !== 'ready' || !current.next || current.loadingMore) return;
    const key = requestKeyRef.current;
    const before = current.next;
    setState({ ...current, loadingMore: true });
    void searchMessages({ query, sessionId, directories: directoriesRef.current, role, includeReasoning, order, limit, before })
      .then((result) => {
        if (requestKeyRef.current !== key || result.status !== 'ok') return;
        setState((latest) => (latest.status === 'ready'
          ? { ...latest, hits: [...latest.hits, ...result.hits], next: result.next, index: result.index, loadingMore: false }
          : latest));
      })
      .catch(() => {
        if (requestKeyRef.current !== key) return;
        setState((latest) => (latest.status === 'ready' ? { ...latest, loadingMore: false } : latest));
      });
  }, [query, sessionId, role, includeReasoning, order, limit]);

  return { state, loadMore };
};
