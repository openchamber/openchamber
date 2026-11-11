import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { searchResult } from './sidebarSearch.fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { EMPTY_CONVERSATION_CONTEXT } from '@/components/search/conversationResultContext';

const opened: Array<[string, string | null]> = [];
mock.module('@/lib/router/openSessionFromRoute', () => ({ openSessionLink: async (session: string, message: string | null) => { opened.push([session, message]); } }));

let dom: Window;
let root: Root;
let originals: Map<string, PropertyDescriptor | undefined>;
let requests: URL[];
let responseRole: 'user' | 'assistant' | 'reasoning';
let pageFails: boolean;
let SidebarConversationRow: typeof import('./SidebarConversationRow').SidebarConversationRow;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  opened.length = 0;
  useSessionUIStore.setState({ currentSessionId: null });
  requests = [];
  responseRole = 'user';
  pageFails = false;
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent,
    CustomEvent: dom.CustomEvent, getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      requests.push(url);
      const secondPage = url.searchParams.has('before');
      if (secondPage && pageFails) throw new Error('page failed');
      return Response.json({ status: 'ok', next: secondPage ? null : '2:older', index: null, hits: [{
        id: secondPage ? 'older-message' : 'another-message', sessionId: 'a-0', sessionTitle: 'Needle conversation',
        role: responseRole, createdAt: 1, directory: '/repo/a', archived: true, snippet: 'The \uE000needle\uE001 match',
      }] });
    },
  };
  originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  ({ SidebarConversationRow } = await import('./SidebarConversationRow'));
  ({ I18nProvider } = await import('@/lib/i18n'));
  const { useUIStore } = await import('@/stores/useUIStore');
  useUIStore.setState({ messageSearchEnabled: true, messageSearchReasoningEnabled: false, showReasoningTraces: false });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const click = async (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => { element.click(); await new Promise<void>((resolve) => setImmediate(resolve)); });
};

for (const mobile of [false, true]) test(`${mobile ? 'phone' : 'desktop'} renders metadata highlights, enriched excerpt and exact message activation without restoration`, async () => {
  await act(async () => root.render(<I18nProvider><SidebarConversationRow
    result={searchResult('a-0', { archived: true, excerpt: { messageId: 'exact-message', role: 'user', snippet: 'The \uE000needle\uE001 answer', createdAt: 1 } })}
    context={{ ...EMPTY_CONVERSATION_CONTEXT, project: { id: 'a', label: 'Project A' } }} mobile={mobile} depth={1}
  /></I18nProvider>));
  expect(document.querySelector('[data-conversation-title] mark')?.textContent).toBe('Needle');
  expect(document.querySelector('[data-search-meta-item="project"]')?.textContent).toBe('Project A');
  expect(document.querySelector('[data-conversation-excerpt-action] mark')?.textContent).toBe('needle');
  expect(document.querySelector('[data-conversation-archived]')).not.toBeNull();
  await click('[data-conversation-title-action]');
  await click('[data-conversation-excerpt-action]');
  expect(opened).toEqual([['a-0', null], ['a-0', 'exact-message']]);
  expect(requests).toHaveLength(0);
});

test('other matches use session/lifecycle/author scope, highlighted excerpts and message paging', async () => {
  await act(async () => root.render(<I18nProvider><SidebarConversationRow
    result={searchResult('a-0', { moreMatches: 3, excerpt: { messageId: 'exact-message', role: 'user', snippet: 'needle', createdAt: 1 } })}
    context={EMPTY_CONVERSATION_CONTEXT} search={{ query: 'needle', lifecycle: 'archived', author: 'user', loadMore: () => undefined }}
  /></I18nProvider>));
  expect(requests).toHaveLength(0);
  await click('[data-conversation-more-matches]');
  expect(requests[0]?.searchParams.get('session')).toBe('a-0');
  expect(requests[0]?.searchParams.get('lifecycle')).toBe('archived');
  expect(requests[0]?.searchParams.get('role')).toBe('user');
  expect(requests[0]?.searchParams.get('reasoning')).toBe('0');
  expect(document.querySelector('[data-sidebar-message-match] mark')?.textContent).toBe('needle');
  await click('[data-sidebar-message-match="another-message"]');
  await click('[data-sidebar-matches-more]');
  expect(requests[1]?.searchParams.get('before')).toBe('2:older');
  await click('[data-sidebar-message-match="older-message"]');
  expect(opened).toEqual([['a-0', 'another-message'], ['a-0', 'older-message']]);
  expect(document.querySelector('[data-sidebar-matches-more]')).toBeNull();
});

test('changing author collapses the old actionable matches before the next request', async () => {
  responseRole = 'assistant';
  const render = (author: 'any' | 'user') => act(async () => root.render(<I18nProvider><SidebarConversationRow result={searchResult('a-0', { moreMatches: 2 })} context={EMPTY_CONVERSATION_CONTEXT} search={{ query: 'needle', lifecycle: 'all', author, loadMore: () => undefined }} /></I18nProvider>));
  await render('any');
  await click('[data-conversation-more-matches]');
  expect(document.querySelector('[data-sidebar-message-match]')).not.toBeNull();
  const count = requests.length;
  await render('user');
  expect(document.querySelector('[data-sidebar-other-matches]')).toBeNull();
  expect(document.querySelector('[data-sidebar-message-match]')).toBeNull();
  expect(requests).toHaveLength(count);
  responseRole = 'user';
  await click('[data-conversation-more-matches]');
  expect(requests.at(-1)?.searchParams.get('role')).toBe('user');
});

test('message-search off immediately removes expanded matches and excerpt actions', async () => {
  const { useUIStore } = await import('@/stores/useUIStore');
  await act(async () => root.render(<I18nProvider><SidebarConversationRow result={searchResult('a-0', { moreMatches: 2, excerpt: { messageId: 'exact', role: 'user', snippet: 'needle', createdAt: 1 } })} context={EMPTY_CONVERSATION_CONTEXT} search={{ query: 'needle', lifecycle: 'all', author: 'any', loadMore: () => undefined }} /></I18nProvider>));
  await click('[data-conversation-more-matches]');
  await act(async () => useUIStore.setState({ messageSearchEnabled: false }));
  expect(document.querySelector('[data-sidebar-other-matches]')).toBeNull();
  expect(document.querySelector('[data-conversation-excerpt-action]')).toBeNull();
  expect(document.querySelector('[data-conversation-more-matches]')).toBeNull();
});

test('failed other-match pages preserve old hits and expose an error with a retryable pager', async () => {
  await act(async () => root.render(<I18nProvider><SidebarConversationRow result={searchResult('a-0', { moreMatches: 3 })} context={EMPTY_CONVERSATION_CONTEXT} search={{ query: 'needle', lifecycle: 'all', author: 'any', loadMore: () => undefined }} /></I18nProvider>));
  await click('[data-conversation-more-matches]');
  pageFails = true;
  await click('[data-sidebar-matches-more]');
  expect(document.querySelector('[data-sidebar-message-match="another-message"]')).not.toBeNull();
  expect(document.querySelector('[data-sidebar-other-matches] [role="status"]')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-sidebar-matches-more]')?.disabled).toBe(false);
  pageFails = false;
  await click('[data-sidebar-matches-more]');
  expect(document.querySelector('[data-sidebar-message-match="older-message"]')).not.toBeNull();
  expect(document.querySelector('[data-sidebar-other-matches] [role="status"]')).toBeNull();
});

test('titles-only policy removes message actions and does not reopen them when switching back', async () => {
  const render = (searchIn: 'titles' | 'everything') => act(async () => root.render(<I18nProvider><SidebarConversationRow result={searchResult('a-0', { moreMatches: 2 })} context={EMPTY_CONVERSATION_CONTEXT} search={{ query: 'needle', lifecycle: 'all', author: 'any', searchIn, loadMore: () => undefined }} /></I18nProvider>));
  await render('everything');
  await click('[data-conversation-more-matches]');
  const count = requests.length;
  await render('titles');
  expect(Boolean(document.querySelector('[data-sidebar-other-matches]'))).toBe(false);
  expect(Boolean(document.querySelector('[data-conversation-more-matches]'))).toBe(false);
  await render('everything');
  expect(Boolean(document.querySelector('[data-sidebar-other-matches]'))).toBe(false);
  expect(requests).toHaveLength(count);
});

test('disabling reasoning immediately removes old reasoning hits and actions', async () => {
  const { useUIStore } = await import('@/stores/useUIStore');
  await act(async () => useUIStore.setState({ messageSearchReasoningEnabled: true, showReasoningTraces: true }));
  responseRole = 'reasoning';
  await act(async () => root.render(<I18nProvider><SidebarConversationRow result={searchResult('a-0', { moreMatches: 2, excerpt: { messageId: 'reasoning', role: 'reasoning', snippet: 'needle', createdAt: 1 } })} context={EMPTY_CONVERSATION_CONTEXT} search={{ query: 'needle', lifecycle: 'all', author: 'any', loadMore: () => undefined }} /></I18nProvider>));
  await click('[data-conversation-more-matches]');
  expect(Boolean(document.querySelector('[data-sidebar-message-match]'))).toBe(true);
  const count = requests.length;
  await act(async () => useUIStore.setState({ showReasoningTraces: false }));
  expect(Boolean(document.querySelector('[data-sidebar-other-matches]'))).toBe(false);
  expect(Boolean(document.querySelector('[data-conversation-excerpt-action]'))).toBe(false);
  expect(requests).toHaveLength(count);
});

test('a runtime identity change closes the old expanded matches without another message request', async () => {
  const { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
  await act(async () => root.render(<I18nProvider><SidebarConversationRow result={searchResult('a-0', { moreMatches: 2 })} context={EMPTY_CONVERSATION_CONTEXT} search={{ query: 'needle', lifecycle: 'all', author: 'any', loadMore: () => undefined }} /></I18nProvider>));
  await click('[data-conversation-more-matches]');
  const count = requests.length;
  try {
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: previous.apiBaseUrl, runtimeKey: 'sidebar-test-other-runtime' }));
    expect(Boolean(document.querySelector('[data-sidebar-other-matches]'))).toBe(false);
    expect(requests.filter((url) => url.pathname === '/api/openchamber/message-search')).toHaveLength(count);
  } finally {
    await act(async () => switchRuntimeEndpoint(previous));
  }
});

test('opening a reasoning hit asks its folds to open, and a user hit clears that request', async () => {
  const { useUIStore } = await import('@/stores/useUIStore');
  const { isReasoningRevealTarget } = await import('@/components/chat/search/reasoningReveal');
  await act(async () => useUIStore.setState({ messageSearchReasoningEnabled: true, showReasoningTraces: true }));
  responseRole = 'reasoning';
  await act(async () => root.render(<I18nProvider><SidebarConversationRow result={searchResult('a-0', { moreMatches: 2, excerpt: { messageId: 'exact-reasoning', role: 'reasoning', snippet: 'needle', createdAt: 1 } })} context={EMPTY_CONVERSATION_CONTEXT} search={{ query: 'needle', lifecycle: 'all', author: 'any', loadMore: () => undefined }} /></I18nProvider>));
  await click('[data-conversation-excerpt-action]');
  expect(isReasoningRevealTarget('exact-reasoning')).toBe(true);
  await click('[data-conversation-more-matches]');
  await click('[data-sidebar-message-match="another-message"]');
  expect(isReasoningRevealTarget('another-message')).toBe(true);
  await click('[data-conversation-title-action]');
  expect(isReasoningRevealTarget('another-message')).toBe(false);
  expect(opened).toEqual([['a-0', 'exact-reasoning'], ['a-0', 'another-message'], ['a-0', null]]);
});
