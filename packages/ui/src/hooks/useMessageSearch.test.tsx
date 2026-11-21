import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { useMessageSearch as SearchHook } from './useMessageSearch';

type Options = Parameters<typeof SearchHook>[0];
type Pending = { url: URL; signal?: AbortSignal | null; resolve: (response: Response) => void; reject: (error: Error) => void };
const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
let requests: Pending[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  if (url.pathname !== '/api/openchamber/message-search') return Promise.resolve(Response.json({}));
  return new Promise<Response>((resolve, reject) => requests.push({ url, signal: init?.signal, resolve, reject }));
});
const { createRoot } = await import('react-dom/client');
const { useMessageSearch } = await import('./useMessageSearch');
let root: Root;
let mounted = false;
let latest: ReturnType<typeof useMessageSearch>;
let options: Options;
function Harness(props: Options) {
  latest = useMessageSearch(props);
  return <div>{'hits' in latest.state ? latest.state.hits.map((hit) => <p key={hit.id}>{hit.snippet}</p>) : null}</div>;
}
const hit = (id: string) => ({ id, sessionId: 'ses_one', sessionTitle: 'One', directory: '/workspace', role: 'user', createdAt: 1, snippet: id });
const page = (id: string, next: string | null = null) => Response.json({ status: 'ok', hits: [hit(id)], next, index: null });
function ready() {
  if (latest.state.status !== 'ready') throw new Error(`Expected ready, got ${latest.state.status}`);
  return latest.state;
}
async function render(patch: Partial<Options> = {}) {
  options = { ...options, ...patch };
  await act(async () => root.render(<Harness {...options} />));
}
async function answer(index: number, response: Response) {
  const request = requests[index];
  if (!request) throw new Error(`Request ${index} missing`);
  await act(async () => request.resolve(response));
}
async function startPage() {
  await act(async () => latest.loadMore());
}
beforeEach(async () => {
  requests = [];
  options = { query: 'needle', enabled: true, limit: 2, sessionId: 'ses_one', lifecycle: 'archived' };
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
  await render();
  await answer(0, page('first', 'cursor-2'));
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  document.body.replaceChildren();
});
afterAll(async () => {
  fetchSpy.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('HTTP 500 preserves messages and cursor, reports page error and retries successfully', async () => {
  expect(ready().pageError).toBe(false);
  await startPage();
  await answer(1, new Response('failed', { status: 500 }));
  expect(ready().hits.map((message) => message.id)).toEqual(['first']);
  expect(document.body.textContent).toBe('first');
  expect(ready().next).toBe('cursor-2');
  expect(ready().loadingMore).toBe(false);
  expect(ready().pageError).toBe(true);
  await startPage();
  expect(requests[2]?.url.searchParams.get('before')).toBe('cursor-2');
  expect(ready().pageError).toBe(false);
  expect(ready().loadingMore).toBe(true);
  await answer(2, page('second'));
  expect(ready().hits.map((message) => message.id)).toEqual(['first', 'second']);
  expect(ready().next).toBeNull();
  expect(ready().loadingMore).toBe(false);
  expect(ready().pageError).toBe(false);
});

test('synchronous duplicate pagination calls issue one cursor request', async () => {
  await act(async () => { latest.loadMore(); latest.loadMore(); });
  expect(requests).toHaveLength(2);
  await answer(1, page('second'));
  expect(ready().hits.map((message) => message.id)).toEqual(['first', 'second']);
});

for (const status of ['unavailable', 'query-too-short'] as const) {
  test(`a ${status} page unlocks retry and preserves loaded messages`, async () => {
    await startPage();
    await answer(1, status === 'unavailable' ? new Response('', { status: 503 }) : Response.json({ status: 'query-too-short' }));
    expect(ready().loadingMore).toBe(false);
    expect(ready().pageError).toBe(true);
    expect(ready().next).toBe('cursor-2');
    expect(ready().hits.map((message) => message.id)).toEqual(['first']);
    await startPage();
    expect(requests).toHaveLength(3);
    await answer(2, page('recovered'));
    expect(ready().pageError).toBe(false);
  });
}

test('network rejection marks the current page as failed without clearing messages', async () => {
  await startPage();
  await act(async () => requests[1]?.reject(new Error('offline')));
  expect(ready().pageError).toBe(true);
  expect(ready().loadingMore).toBe(false);
  expect(ready().hits.map((message) => message.id)).toEqual(['first']);
});

test('a changed key aborts the pending page and ignores a late success and stale callback', async () => {
  const oldLoadMore = latest.loadMore;
  await startPage();
  const oldPage = requests[1];
  await render({ query: 'different' });
  expect(oldPage?.signal?.aborted).toBe(true);
  await answer(2, page('new-query', 'new-cursor'));
  await answer(1, page('obsolete'));
  expect(ready().hits.map((message) => message.id)).toEqual(['new-query']);
  await act(async () => oldLoadMore());
  expect(requests).toHaveLength(3);
  await startPage();
  expect(requests[3]?.url.searchParams.get('before')).toBe('new-cursor');
  await answer(3, page('new-page'));
  expect(ready().hits.map((message) => message.id)).toEqual(['new-query', 'new-page']);
});

test('disabling aborts pagination and ignores late failure before re-enabling the same query', async () => {
  await startPage();
  await render({ enabled: false });
  expect(requests[1]?.signal?.aborted).toBe(true);
  await act(async () => requests[1]?.reject(new Error('late failure')));
  expect(latest.state.status).toBe('idle');
  await act(async () => latest.loadMore());
  expect(requests).toHaveLength(2);
  await render({ enabled: true });
  await answer(2, page('fresh', 'fresh-cursor'));
  expect(ready().pageError).toBe(false);
  expect(ready().hits.map((message) => message.id)).toEqual(['fresh']);
});

test('a stale page rejection cannot unlock or mark a newer page as failed', async () => {
  await startPage();
  await render({ query: 'different' });
  await answer(2, page('new-query', 'new-cursor'));
  await startPage();
  await act(async () => requests[1]?.reject(new Error('old page failed')));
  expect(ready().loadingMore).toBe(true);
  expect(ready().pageError).toBe(false);
  await act(async () => latest.loadMore());
  expect(requests).toHaveLength(4);
  await answer(3, page('new-page'));
  expect(ready().hits.map((message) => message.id)).toEqual(['new-query', 'new-page']);
});

test('a disabled page cannot publish after the same query is enabled again', async () => {
  await startPage();
  await render({ enabled: false });
  await render({ enabled: true });
  await answer(2, page('fresh'));
  await answer(1, page('old-page'));
  expect(ready().hits.map((message) => message.id)).toEqual(['fresh']);
  expect(ready().pageError).toBe(false);
});

test('unmount aborts the outstanding message page', async () => {
  await startPage();
  await act(async () => root.unmount());
  mounted = false;
  expect(requests[1]?.signal?.aborted).toBe(true);
  await answer(1, page('late'));
});
