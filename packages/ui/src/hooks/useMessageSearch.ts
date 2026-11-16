import React from 'react';

import {
  isSearchableQuery,
  searchMessages,
  type MessageSearchHit,
  type MessageSearchIndexStatus,
  type MessageSearchRole,
} from '@/lib/messageSearch';
import type { OmniLifecycle } from '@/lib/search/omniQuery';

type MessageSearchState =
  | { status: 'idle' }
  | { status: 'too-short' }
  | { status: 'unavailable' }
  | { status: 'loading'; hits: MessageSearchHit[] }
  | { status: 'ready'; hits: MessageSearchHit[]; next: string | null; index: MessageSearchIndexStatus | null; loadingMore: boolean; pageError?: boolean }
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
  lifecycle?: OmniLifecycle;
};

const IDLE: MessageSearchState = { status: 'idle' };

/**
 * One search at a time: a new query or filter aborts the request in flight,
 * and an answer to anything but the current request is dropped. The hits of
 * the previous query stay visible while the next one loads, so the list does
 * not flash empty between keystrokes.
 */
export const useMessageSearch = ({ query, enabled, limit, sessionId = null, directories, role = null, includeReasoning = true, order = 'desc', lifecycle }: MessageSearchOptions) => {
  const [state, setState] = React.useState<MessageSearchState>(IDLE);
  const directoriesKey = (directories ?? []).join('\n');
  const requestKey = `${enabled}\u0000${query}\u0000${sessionId ?? ''}\u0000${directoriesKey}\u0000${role ?? ''}\u0000${order}\u0000${limit}\u0000${includeReasoning}\u0000${lifecycle ?? ''}`;
  const requestKeyRef = React.useRef(requestKey);
  requestKeyRef.current = requestKey;
  const pageControllerRef = React.useRef<AbortController | null>(null);
  const readyKeyRef = React.useRef<string | null>(null);
  const directoriesRef = React.useRef(directories);
  directoriesRef.current = directories;

  React.useEffect(() => {
    readyKeyRef.current = null;
    pageControllerRef.current?.abort();
    pageControllerRef.current = null;
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
    searchMessages({ query, sessionId, directories: directoriesRef.current, role, includeReasoning, order, limit, lifecycle, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
        if (result.status === 'ok') {
          readyKeyRef.current = requestKey;
          setState({ status: 'ready', hits: result.hits, next: result.next, index: result.index, loadingMore: false, pageError: false });
        }
        else if (result.status === 'query-too-short') setState({ status: 'too-short' });
        else setState({ status: 'unavailable' });
      })
      .catch(() => {
        if (!controller.signal.aborted && requestKeyRef.current === requestKey) setState({ status: 'error', hits: [] });
      });
    return () => {
      controller.abort();
      pageControllerRef.current?.abort();
      pageControllerRef.current = null;
      readyKeyRef.current = null;
    };
    // `requestKey` stands for query, filters and page size together.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, requestKey]);

  const stateRef = React.useRef(state);
  stateRef.current = state;

  const loadMore = React.useCallback(() => {
    const current = stateRef.current;
    if (!enabled || requestKey !== requestKeyRef.current || readyKeyRef.current !== requestKey
      || current.status !== 'ready' || !current.next || current.loadingMore || pageControllerRef.current) return;
    const key = requestKey;
    const before = current.next;
    const controller = new AbortController();
    pageControllerRef.current = controller;
    setState({ ...current, loadingMore: true, pageError: false });
    const failPage = () => {
      if (controller.signal.aborted || requestKeyRef.current !== key) return;
      setState((latest) => (latest.status === 'ready' ? { ...latest, loadingMore: false, pageError: true } : latest));
    };
    void searchMessages({ query, sessionId, directories: directoriesRef.current, role, includeReasoning, order, limit, lifecycle, before, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || requestKeyRef.current !== key) return;
        if (result.status !== 'ok') { failPage(); return; }
        setState((latest) => (latest.status === 'ready'
          ? { ...latest, hits: [...latest.hits, ...result.hits], next: result.next, index: result.index, loadingMore: false, pageError: false }
          : latest));
      })
      .catch(failPage).finally(() => {
        if (pageControllerRef.current === controller) pageControllerRef.current = null;
      });
  }, [enabled, requestKey, query, sessionId, role, includeReasoning, order, limit, lifecycle]);

  return { state, loadMore };
};
