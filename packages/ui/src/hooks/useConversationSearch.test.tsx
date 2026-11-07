import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ConversationContentHit } from '@/lib/messageSearch';
import { rankConversationMetadata, type ConversationMetadata } from '@/lib/search/conversationSearch';
import type { useConversationSearch } from './useConversationSearch';

type Options = Parameters<typeof useConversationSearch>[0];
type Pending = { url: URL; signal?: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void };
type Timer = { id: ReturnType<Window['setTimeout']>; delay: number; run: () => void };
type SearchIndex = { backfill: { state: 'idle' | 'running' | 'done'; total: number; done: number }; sessions: number; messages: number; lifecycleComplete: boolean } | null;
type ConversationPage = {
  status: 'ok';
  hits: ConversationContentHit[];
  next: string | null;
  totals: { sessions: number; byDirectory: Record<string, number> } | null;
  index: SearchIndex;
};
type SearchResponse = ConversationPage | { status: 'query-too-short' } | { status: 'unavailable' } | { state: 'unsupported' | 'off' | 'on' | 'failed'; sizeBytes: number; index: SearchIndex } | { error: string };

const DEBOUNCE_MS = 150;
const CONTENT_PATH = '/api/openchamber/message-search/sessions';
const STATUS_PATH = '/api/openchamber/message-search/status';

const ITEMS: ConversationMetadata[] = [
  { sessionId: 'ses_a', title: 'Alpha plan', projectLabel: 'openchamber', worktreeLabel: 'main', directory: '/repo/a', archived: false },
  { sessionId: 'ses_b', title: 'Alpha notes', projectLabel: 'openchamber', worktreeLabel: null, directory: '/repo/a', archived: false },
  { sessionId: 'ses_c', title: 'Alpha review', projectLabel: 'other', worktreeLabel: null, directory: '/repo/b', archived: true },
];
const NO_ITEMS: ConversationMetadata[] = [];
const ITEM_IDS = rankConversationMetadata(ITEMS, 'alpha').map((match) => match.sessionId);

const hit = (sessionId: string, overrides: Partial<ConversationContentHit> = {}): ConversationContentHit => ({
  sessionId, sessionTitle: `Title ${sessionId}`, directory: '/repo/a', archived: false,
  messageId: `msg_${sessionId}`, role: 'user', createdAt: 1, snippet: 'about \uE000alpha\uE001', matchCount: 1, ...overrides,
});
const page = (hits: ConversationContentHit[], extra: Partial<Omit<ConversationPage, 'status' | 'hits'>> = {}): ConversationPage => ({ status: 'ok', hits, next: null, totals: null, index: null, ...extra });
const ids = (results: ReadonlyArray<{ sessionId: string }>) => results.map((result) => result.sessionId);

const setup = async () => {
  const dom = new Window({ url: 'http://localhost' });
  const contentRequests: Pending[] = [];
  const statusRequests: Pending[] = [];
  const timers: Timer[] = [];
  const originalSetTimeout = dom.setTimeout.bind(dom);
  const originalClearTimeout = dom.clearTimeout.bind(dom);

  // Each request waits for the test to answer it, even after an abort: the hook's own guard
  // must keep a late answer from writing state.
  const track = (queue: Pending[], url: URL, signal?: AbortSignal | null) => new Promise<Response>((resolve, reject) => {
    queue.push({ url, signal: signal ?? undefined, resolve, reject });
  });
  const fetchStub = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === CONTENT_PATH) return track(contentRequests, url, init?.signal);
    if (url.pathname === STATUS_PATH) return track(statusRequests, url, init?.signal);
    return Promise.resolve(new Response('{}', { status: 404 }));
  };

  // The hook's debounce runs on window.setTimeout; the test fires it on demand.
  dom.setTimeout = (run, delay = 0, ...args) => {
    const id = originalSetTimeout(() => {}, 0);
    originalClearTimeout(id);
    timers.push({ id, delay, run: () => run(...args) });
    return id;
  };
  dom.clearTimeout = (id) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };

  const globals = [
    ['window', dom], ['document', dom.document], ['navigator', dom.navigator], ['location', dom.location], ['localStorage', dom.localStorage],
    ['Element', dom.Element], ['HTMLElement', dom.HTMLElement], ['Node', dom.Node], ['Event', dom.Event], ['CustomEvent', dom.CustomEvent],
    ['IS_REACT_ACT_ENVIRONMENT', true], ['fetch', fetchStub],
  ] satisfies ReadonlyArray<readonly [PropertyKey, unknown]>;
  const originals = new Map(globals.map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { useConversationSearch } = await import('./useConversationSearch');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
  const { switchRuntimeEndpoint, getRuntimeKey, getRuntimeApiBaseUrl } = await import('@/lib/runtime-switch');
  const previousRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };

  const previousMessageSearch = useUIStore.getState().messageSearchEnabled;
  const previousMessageSearchReasoning = useUIStore.getState().messageSearchReasoningEnabled;
  const previousShowReasoningTraces = useUIStore.getState().showReasoningTraces;
  useUIStore.setState({ messageSearchEnabled: true });

  let latest: ReturnType<typeof useConversationSearch> | null = null;
  function Harness(options: Options) {
    latest = useConversationSearch(options);
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const base: Options = {
    enabled: true, text: 'alpha', lifecycle: 'all', searchIn: 'everything', author: 'any',
    metadataItems: ITEMS, isAdmitted: () => true, contentDebounceMs: DEBOUNCE_MS,
  };
  let rendered: Options = base;

  const state = () => {
    if (!latest) throw new Error('Hook has not rendered');
    return latest;
  };
  const render = async (next: Partial<Options> = {}) => {
    rendered = { ...rendered, ...next };
    const options = rendered;
    await act(async () => { root.render(<Harness {...options} />); });
  };
  const yieldToEventLoop = () => act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  const drain = async () => { for (let i = 0; i < 20; i += 1) await yieldToEventLoop(); };
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 500 && !done(); i += 1) await yieldToEventLoop();
    if (!done()) throw new Error('Expected condition was not reached');
  };
  const pendingDelays = () => timers.map((timer) => timer.delay);
  const fireTimers = async (delay: number) => {
    for (const timer of timers.filter((candidate) => candidate.delay === delay)) {
      timers.splice(timers.indexOf(timer), 1);
      await act(async () => { timer.run(); });
    }
    await drain();
  };
  const loadMore = async () => {
    await act(async () => { state().loadMore(); });
    await drain();
  };
  const respond = async <TResponse extends SearchResponse>(request: Pending | undefined, body: TResponse, status = 200) => {
    if (!request) throw new Error('Expected a pending request');
    await act(async () => { request.resolve(Response.json(body, { status })); });
    await drain();
  };
  const fail = async (request: Pending | undefined, error: Error) => {
    if (!request) throw new Error('Expected a pending request');
    await act(async () => { request.reject(error); });
    await drain();
  };
  const setMessageSearch = async (value: boolean) => {
    await act(async () => { useUIStore.setState({ messageSearchEnabled: value }); });
  };
  const setReasoning = async (messageSearchReasoningEnabled: boolean, showReasoningTraces: boolean) => {
    await act(async () => { useUIStore.setState({ messageSearchReasoningEnabled, showReasoningTraces }); });
  };
  const setVSCodeRuntime = () => {
    Object.defineProperty(dom, '__OPENCHAMBER_RUNTIME_APIS__', { configurable: true, value: { runtime: { isVSCode: true } } });
  };

  const dispose = async () => {
    await act(async () => { root.unmount(); });
    registerRuntimeAPIs(null);
    // Runs after every test: undo an endpoint switch so it cannot leak into other tests.
    if (getRuntimeKey() !== previousRuntime.runtimeKey || getRuntimeApiBaseUrl() !== previousRuntime.apiBaseUrl) {
      switchRuntimeEndpoint({ apiBaseUrl: previousRuntime.apiBaseUrl, runtimeKey: previousRuntime.runtimeKey });
    }
    useUIStore.setState({ messageSearchEnabled: previousMessageSearch, messageSearchReasoningEnabled: previousMessageSearchReasoning, showReasoningTraces: previousShowReasoningTraces });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.abort();
  };

  return {
    state, render, pendingDelays, fireTimers, loadMore, respond, fail, settle, drain, setMessageSearch, setReasoning, dispose,
    contentRequests, statusRequests,
    setVSCodeRuntime,
    switchRuntimeEndpoint, getRuntimeKey,
  };
};

test('content search waits for the debounce, then asks once for the settled text', async () => {
  const f = await setup();
  try {
    await f.render({ text: 'alp' });
    await f.render({ text: 'alpha' });
    expect(f.pendingDelays()).toEqual([DEBOUNCE_MS]);
    expect(f.contentRequests).toHaveLength(0);
    expect(f.state().contentStatus.kind).not.toBe('loading');

    await f.fireTimers(DEBOUNCE_MS);
    expect(f.contentRequests).toHaveLength(1);
    expect(f.contentRequests[0].url.searchParams.get('q')).toBe('alpha');
    expect(f.state().contentStatus.kind).toBe('loading');
  } finally {
    await f.dispose();
  }
});

test('a changed query drops shown content at once, keeps metadata, and ignores the answer to the old request', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_x')]));
    expect(ids(f.state().results)).toEqual([...ITEM_IDS, 'ses_x']);

    await f.render({ lifecycle: 'active' });
    expect(ids(f.state().results)).toEqual(ITEM_IDS);
    expect(f.state().contentStatus.kind).toBe('idle');

    await f.fireTimers(DEBOUNCE_MS);
    expect(f.contentRequests).toHaveLength(2);
    await f.render({ lifecycle: 'archived' });
    expect(f.contentRequests[1].signal?.aborted).toBe(true);
    await f.respond(f.contentRequests[1], page([hit('ses_late')]));
    expect(ids(f.state().results)).toEqual(ITEM_IDS);
    expect(f.state().contentStatus.kind).toBe('idle');
  } finally {
    await f.dispose();
  }
});

test('a stale loadMore answer never reaches a newer query, and loadMore does nothing for a stale key', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_1')], { next: 'cursor-1' }));
    expect(ids(f.state().results)).toEqual(['ses_1']);

    await f.loadMore();
    expect(f.contentRequests).toHaveLength(2);
    expect(f.contentRequests[1].url.searchParams.get('before')).toBe('cursor-1');

    await f.render({ text: 'alphabet' });
    await f.loadMore();
    expect(f.contentRequests).toHaveLength(2);

    await f.respond(f.contentRequests[1], page([hit('ses_2')]));
    expect(ids(f.state().results)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('content requests use reasoning only when both reasoning settings allow it', async () => {
  const f = await setup();
  try {
    await f.setReasoning(true, true);
    await f.render({ metadataItems: NO_ITEMS, author: 'reasoning' });
    await f.fireTimers(DEBOUNCE_MS);
    expect(f.contentRequests[0].url.searchParams.get('role')).toBe('reasoning');
    expect(f.contentRequests[0].url.searchParams.get('reasoning')).toBeNull();
    await f.respond(f.contentRequests[0], page([hit('ses_1')], { next: 'cursor-1' }));
    await f.loadMore();
    expect(f.contentRequests[1].url.searchParams.get('role')).toBe('reasoning');
    expect(f.contentRequests[1].url.searchParams.get('reasoning')).toBeNull();

    await f.setReasoning(true, false);
    expect(f.contentRequests[1].signal?.aborted).toBe(true);
    await f.fireTimers(DEBOUNCE_MS);
    expect(f.contentRequests[2].url.searchParams.get('role')).toBeNull();
    expect(f.contentRequests[2].url.searchParams.get('reasoning')).toBe('0');
  } finally {
    await f.dispose();
  }
});

test('mode transitions abort a pending page and keep it from repopulating results', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_1')], { next: 'cursor-1' }));
    await f.loadMore();
    const pendingPage = f.contentRequests[1];
    await f.render({ enabled: false });
    expect(pendingPage.signal?.aborted).toBe(true);
    await f.respond(pendingPage, page([hit('ses_late')]));
    expect(f.state().results).toEqual([]);

    await f.render({ enabled: true, searchIn: 'everything' });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[2], page([hit('ses_2')], { next: 'cursor-2' }));
    await f.loadMore();
    const titlesPage = f.contentRequests[3];
    await f.render({ searchIn: 'titles' });
    expect(titlesPage.signal?.aborted).toBe(true);
    await f.respond(titlesPage, page([hit('ses_late_titles')]));
    expect(f.state().results).toEqual([]);

    await f.render({ searchIn: 'everything' });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[4], page([hit('ses_3')], { next: 'cursor-3' }));
    await f.loadMore();
    const offPage = f.contentRequests[5];
    await f.setMessageSearch(false);
    expect(offPage.signal?.aborted).toBe(true);
    await f.respond(offPage, page([hit('ses_late_off')]));
    expect(f.state().results).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('unmount aborts a pending page request', async () => {
  const f = await setup();
  let disposed = false;
  try {
    await f.render({ metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_1')], { next: 'cursor-1' }));
    await f.loadMore();
    const pendingPage = f.contentRequests[1];
    await f.dispose();
    disposed = true;
    expect(pendingPage.signal?.aborted).toBe(true);
    await f.respond(pendingPage, page([hit('ses_late')]));
  } finally {
    if (!disposed) await f.dispose();
  }
});

test('content hits merge into metadata rows by session without duplicates or reordering', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_b', { messageId: 'msg_b1', matchCount: 3 }), hit('ses_zz')], { next: 'cursor-1' }));
    const first = f.state().results;
    expect(ids(first)).toEqual([...ITEM_IDS, 'ses_zz']);
    const excerptRow = first.find((result) => result.sessionId === 'ses_b');
    expect(excerptRow?.metadata).not.toBeNull();
    expect(excerptRow?.excerpt?.messageId).toBe('msg_b1');
    expect(excerptRow?.moreMatches).toBe(2);
    expect(first.find((result) => result.sessionId === 'ses_zz')?.metadata).toBeNull();

    await f.loadMore();
    await f.respond(f.contentRequests[1], page([hit('ses_zz'), hit('ses_c', { messageId: 'msg_c1' })]));
    const second = f.state().results;
    expect(ids(second)).toEqual([...ITEM_IDS, 'ses_zz']);
    expect(second.find((result) => result.sessionId === 'ses_c')?.excerpt?.messageId).toBe('msg_c1');
  } finally {
    await f.dispose();
  }
});

test('10k metadata and content rows merge with linear ID reads and preserve first-hit enrichment across pages', async () => {
  const f = await setup();
  const messageSearch = await import('@/lib/messageSearch');
  const size = 10_000;
  const metadataItems: ConversationMetadata[] = Array.from({ length: size }, (_, index) => ({
    sessionId: `ses_large_${index}`, title: 'Alpha metadata title', projectLabel: null, worktreeLabel: null, directory: '/repo/a', archived: false,
  }));
  let sessionIdReads = 0;
  const hits = metadataItems.map((item, index): ConversationContentHit => ({
    ...hit(item.sessionId, { sessionTitle: 'Content title', snippet: `First snippet ${index}` }),
    get sessionId() { sessionIdReads += 1; return item.sessionId; },
  }));
  const search = spyOn(messageSearch, 'searchConversations')
    .mockResolvedValueOnce({ status: 'ok', hits, next: 'large-page-2', totals: null, index: null })
    .mockResolvedValueOnce({ status: 'ok', hits: [
      hit('ses_large_0', { snippet: 'Older duplicate snippet' }),
      hit('ses_extra', { snippet: 'Newest content-only snippet' }),
      hit('ses_extra', { snippet: 'Older content-only snippet' }),
    ], next: null, totals: null, index: null });
  try {
    await f.render({ metadataItems });
    await f.fireTimers(DEBOUNCE_MS);
    expect(ids(f.state().results)).toEqual(metadataItems.map((item) => item.sessionId));
    expect(f.state().results[0]).toMatchObject({ title: 'Alpha metadata title', excerpt: { snippet: 'First snippet 0' } });
    expect(f.state().results[size - 1]).toMatchObject({ title: 'Alpha metadata title', excerpt: { snippet: 'First snippet 9999' } });
    // Count identifier accesses on real input records, not calls to a chosen lookup implementation.
    expect(sessionIdReads).toBeLessThanOrEqual(size * 10);
    sessionIdReads = 0;
    await f.loadMore();
    const results = f.state().results;
    expect(ids(results)).toEqual([...metadataItems.map((item) => item.sessionId), 'ses_extra']);
    expect(new Set(ids(results)).size).toBe(size + 1);
    expect(results[0]).toMatchObject({ title: 'Alpha metadata title', excerpt: { snippet: 'First snippet 0' } });
    expect(results[size]).toMatchObject({ title: 'Title ses_extra', excerpt: { snippet: 'Newest content-only snippet' } });
    expect(sessionIdReads).toBeLessThanOrEqual(size * 10);
  } finally {
    search.mockRestore();
    await f.dispose();
  }
}, 30_000);

test('duplicate next-page calls send one request, and a failed page can be retried', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_1')], { next: 'cursor-1' }));

    expect(f.state().contentStatus).toMatchObject({ kind: 'ready', pageError: false });
    await act(async () => {
      f.state().loadMore();
      f.state().loadMore();
    });
    await f.drain();
    expect(f.contentRequests).toHaveLength(2);
    expect(f.state().loadingMore).toBe(true);
    await f.fail(f.contentRequests[1], new TypeError('Network down'));
    expect(f.state().loadingMore).toBe(false);
    expect(ids(f.state().results)).toEqual(['ses_1']);
    expect(f.state().contentStatus).toEqual({ kind: 'ready', indexing: null, lifecycleComplete: true, hasMore: true, pageError: true });

    await f.loadMore();
    expect(f.contentRequests).toHaveLength(3);
    expect(f.contentRequests[2].url.searchParams.get('before')).toBe('cursor-1');
    expect(f.state().contentStatus).toMatchObject({ kind: 'ready', pageError: false });
    expect(f.state().loadingMore).toBe(true);
    await f.respond(f.contentRequests[2], page([hit('ses_2')]));
    expect(ids(f.state().results)).toEqual(['ses_1', 'ses_2']);
    expect(f.state().contentStatus).toEqual({ kind: 'ready', indexing: null, lifecycleComplete: true, hasMore: false, pageError: false });
  } finally {
    await f.dispose();
  }
});

for (const response of [
  { name: 'HTTP 500', body: { error: 'failed' }, status: 500 },
  { name: 'unavailable', body: { status: 'unavailable' }, status: 503 },
  { name: 'query-too-short', body: { status: 'query-too-short' }, status: 200 },
] satisfies ReadonlyArray<{ name: string; body: SearchResponse; status: number }>) {
  test(`a grouped ${response.name} page reports failure and preserves results and cursor for retry`, async () => {
    const f = await setup();
    try {
      await f.render({ metadataItems: ITEMS });
      await f.fireTimers(DEBOUNCE_MS);
      await f.respond(f.contentRequests[0], page([hit('ses_content')], { next: 'cursor-failed', totals: { sessions: 2, byDirectory: { '/repo/a': 2 } } }));
      const results = f.state().results;
      const total = f.state().totalCount;
      await f.loadMore();
      await f.respond(f.contentRequests[1], response.body, response.status);
      expect(f.state().results).toEqual(results);
      expect(f.state().totalCount).toBe(total);
      expect(f.state().contentStatus).toMatchObject({ kind: 'ready', hasMore: true, pageError: true });
      expect(f.state().loadingMore).toBe(false);
      await f.loadMore();
      expect(f.contentRequests[2].url.searchParams.get('before')).toBe('cursor-failed');
      expect(f.state().contentStatus).toMatchObject({ kind: 'ready', pageError: false });
      await f.respond(f.contentRequests[2], page([hit('ses_recovered')]));
      expect(ids(f.state().results)).toEqual([...ITEM_IDS, 'ses_content', 'ses_recovered']);
      expect(f.state().contentStatus).toMatchObject({ kind: 'ready', hasMore: false, pageError: false });
      expect(f.state().loadingMore).toBe(false);
    } finally {
      await f.dispose();
    }
  });
}

test('a stale grouped failure cannot set page error or unlock a newer pending page', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_old')], { next: 'old-cursor' }));
    await f.loadMore();
    await f.render({ text: 'different' });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[2], page([hit('ses_new')], { next: 'new-cursor' }));
    await f.loadMore();
    await f.fail(f.contentRequests[1], new Error('old page failed'));
    expect(f.state().contentStatus).toMatchObject({ kind: 'ready', hasMore: true, pageError: false });
    expect(f.state().loadingMore).toBe(true);
    expect(ids(f.state().results)).toEqual(['ses_new']);
    await f.loadMore();
    expect(f.contentRequests).toHaveLength(4);
    await f.respond(f.contentRequests[3], page([hit('ses_new_page')]));
    expect(f.state().contentStatus).toMatchObject({ kind: 'ready', hasMore: false, pageError: false });
  } finally {
    await f.dispose();
  }
});

test('a failed next page for a stale key is ignored and writes no status', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_1')], { next: 'cursor-1' }));
    await f.loadMore();

    await f.render({ lifecycle: 'archived' });
    await f.fail(f.contentRequests[1], new TypeError('Network down'));
    expect(f.state().loadingMore).toBe(false);
    expect(f.state().results).toEqual([]);
    expect(f.state().contentStatus.kind).toBe('idle');
  } finally {
    await f.dispose();
  }
});

test('content-only hits outside admitted directories are dropped, and paging still continues', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: NO_ITEMS, isAdmitted: (directory) => directory !== '/hidden' });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_hidden', { directory: '/hidden' }), hit('ses_ok')], { next: 'cursor-1' }));
    expect(ids(f.state().results)).toEqual(['ses_ok']);

    await f.loadMore();
    await f.respond(f.contentRequests[1], page([hit('ses_hidden_2', { directory: '/hidden' }), hit('ses_more')]));
    expect(ids(f.state().results)).toEqual(['ses_ok', 'ses_more']);
    expect(f.state().contentStatus).toEqual({ kind: 'ready', indexing: null, lifecycleComplete: true, hasMore: false, pageError: false });
  } finally {
    await f.dispose();
  }
});

test('disabled search does no work and returns no results', async () => {
  const f = await setup();
  try {
    await f.render({ enabled: false });
    expect(f.pendingDelays()).toEqual([]);
    await f.drain();
    expect(f.contentRequests).toHaveLength(0);
    expect(f.state().results).toEqual([]);
    expect(f.state().metadataCount).toBe(0);
    expect(f.state().totalCount).toBe(0);
    expect(f.state().countsByDirectory?.size).toBe(0);
    expect(f.state().contentStatus.kind).toBe('idle');
  } finally {
    await f.dispose();
  }
});

test('an empty query or a titles-only search stays idle without a request', async () => {
  const f = await setup();
  try {
    await f.render({ text: '' });
    expect(f.state().contentStatus.kind).toBe('idle');
    expect(f.pendingDelays()).toEqual([]);

    await f.render({ text: 'alpha', searchIn: 'titles' });
    expect(f.state().contentStatus.kind).toBe('idle');
    expect(f.pendingDelays()).toEqual([]);
    await f.drain();
    expect(f.contentRequests).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test('message search switched off shows off without a request', async () => {
  const f = await setup();
  try {
    await f.setMessageSearch(false);
    await f.render({ metadataItems: ITEMS });
    expect(f.state().contentStatus.kind).toBe('off');
    expect(f.pendingDelays()).toEqual([]);
    expect(f.state().totalCount).toBe(ITEM_IDS.length);
    await f.drain();
    expect(f.contentRequests).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test('a VS Code runtime shows unsupported without a request', async () => {
  const f = await setup();
  try {
    f.setVSCodeRuntime();
    await f.render({ metadataItems: ITEMS });
    expect(f.state().contentStatus.kind).toBe('unsupported');
    expect(f.pendingDelays()).toEqual([]);
    expect(ids(f.state().results)).toEqual(ITEM_IDS);
  } finally {
    await f.dispose();
  }
});

test('a 503 whose status says unsupported shows unsupported', async () => {
  const f = await setup();
  try {
    await f.render();
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], { status: 'unavailable' }, 503);
    await f.settle(() => f.statusRequests.length === 1);
    await f.respond(f.statusRequests[0], { state: 'unsupported', sizeBytes: 0, index: null });
    expect(f.state().contentStatus.kind).toBe('unsupported');
  } finally {
    await f.dispose();
  }
});

test('a 503 whose status says failed shows failed, and a server or network error shows error', async () => {
  const f = await setup();
  try {
    await f.render();
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], { status: 'unavailable' }, 503);
    await f.settle(() => f.statusRequests.length === 1);
    await f.respond(f.statusRequests[0], { state: 'failed', sizeBytes: 0, index: null });
    expect(f.state().contentStatus.kind).toBe('failed');

    await f.render({ text: 'alphas' });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[1], { error: 'boom' }, 500);
    expect(f.state().contentStatus.kind).toBe('error');

    await f.render({ text: 'alphast' });
    await f.fireTimers(DEBOUNCE_MS);
    await f.fail(f.contentRequests[2], new TypeError('Network down'));
    expect(f.state().contentStatus.kind).toBe('error');
  } finally {
    await f.dispose();
  }
});

test('a failed status probe reports error', async () => {
  const f = await setup();
  try {
    await f.render();
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], { status: 'unavailable' }, 503);
    await f.settle(() => f.statusRequests.length === 1);
    await f.fail(f.statusRequests[0], new TypeError('Network down'));
    expect(f.state().contentStatus.kind).toBe('error');
  } finally {
    await f.dispose();
  }
});

test('a too-short query reports too-short and shows no content', async () => {
  const f = await setup();
  try {
    await f.render({ text: 'al', metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], { status: 'query-too-short' });
    expect(f.state().contentStatus.kind).toBe('too-short');
    expect(f.state().results).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('ready reports the running backfill and an incomplete lifecycle, then a finished index', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([], {
      next: 'cursor-1',
      index: { backfill: { state: 'running', total: 10, done: 4 }, sessions: 2, messages: 9, lifecycleComplete: false },
    }));
    expect(f.state().contentStatus).toEqual({ kind: 'ready', indexing: { done: 4, total: 10 }, lifecycleComplete: false, hasMore: true, pageError: false });

    await f.render({ text: 'alphas' });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[1], page([], { index: { backfill: { state: 'done', total: 10, done: 10 }, sessions: 10, messages: 90, lifecycleComplete: true } }));
    expect(f.state().contentStatus).toEqual({ kind: 'ready', indexing: null, lifecycleComplete: true, hasMore: false, pageError: false });
  } finally {
    await f.dispose();
  }
});

test('a runtime endpoint switch drops content results and sends the next request to the new runtime', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: NO_ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([hit('ses_1')]));
    expect(ids(f.state().results)).toEqual(['ses_1']);

    const previousKey = f.getRuntimeKey();
    await act(async () => { f.switchRuntimeEndpoint({ apiBaseUrl: 'https://other.example.test/' }); });
    expect(f.getRuntimeKey()).not.toBe(previousKey);
    expect(ids(f.state().results)).toEqual([]);
    expect(f.state().contentStatus.kind).toBe('idle');

    await f.fireTimers(DEBOUNCE_MS);
    expect(f.contentRequests).toHaveLength(2);
    expect(f.contentRequests[1].url.host).toBe('other.example.test');
  } finally {
    await f.dispose();
  }
});

test('counts add content totals to metadata matches and exclude those matches from the request', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    expect(f.contentRequests[0].url.searchParams.getAll('exclude')).toEqual(ITEM_IDS);
    await f.respond(f.contentRequests[0], page([], { totals: { sessions: 5, byDirectory: { '/repo/a': 3, '/repo/b': 2 } } }));

    expect(f.state().metadataCount).toBe(3);
    expect(f.state().totalCount).toBe(8);
    expect(Object.fromEntries(f.state().countsByDirectory ?? new Map())).toEqual({ '/repo/a': 5, '/repo/b': 3 });
  } finally {
    await f.dispose();
  }
});

test('above 200 metadata matches the request sends no exclusions and the counts are unknown', async () => {
  const f = await setup();
  try {
    const many: ConversationMetadata[] = Array.from({ length: 201 }, (_, index) => ({
      sessionId: `ses_${index}`, title: `Alpha ${index}`, projectLabel: null, worktreeLabel: null, directory: '/repo/a', archived: false,
    }));
    await f.render({ metadataItems: many });
    await f.fireTimers(DEBOUNCE_MS);
    expect(f.contentRequests[0].url.searchParams.getAll('exclude')).toEqual([]);
    await f.respond(f.contentRequests[0], page([], { totals: { sessions: 5, byDirectory: { '/repo/a': 5 } } }));

    expect(f.state().metadataCount).toBe(201);
    expect(f.state().totalCount).toBeNull();
    expect(f.state().countsByDirectory).toBeNull();
  } finally {
    await f.dispose();
  }
});

test('capped server totals leave eligible content counts unknown', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    await f.respond(f.contentRequests[0], page([], { totals: null }));
    expect(f.state().totalCount).toBeNull();
    expect(f.state().countsByDirectory).toBeNull();
  } finally {
    await f.dispose();
  }
});

test('while content is loading or failed, counts stay metadata-only', async () => {
  const f = await setup();
  try {
    await f.render({ metadataItems: ITEMS });
    await f.fireTimers(DEBOUNCE_MS);
    expect(f.state().contentStatus.kind).toBe('loading');
    expect(f.state().totalCount).toBe(3);
    expect(Object.fromEntries(f.state().countsByDirectory ?? new Map())).toEqual({ '/repo/a': 2, '/repo/b': 1 });

    await f.respond(f.contentRequests[0], { error: 'boom' }, 500);
    expect(f.state().contentStatus.kind).toBe('error');
    expect(f.state().totalCount).toBe(3);
    expect(Object.fromEntries(f.state().countsByDirectory ?? new Map())).toEqual({ '/repo/a': 2, '/repo/b': 1 });
  } finally {
    await f.dispose();
  }
});
