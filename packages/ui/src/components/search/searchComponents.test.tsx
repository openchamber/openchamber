import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

import { ConversationResultRow } from './ConversationResultRow';
import { SearchStatusLine } from './SearchStatusLine';
import { I18nProvider } from '@/lib/i18n';
import type { ContentSearchStatus } from '@/hooks/useConversationSearch';

const withDom = async (run: () => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try { await run(); } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('conversation row marks title and excerpt, and routes row actions', () => withDom(async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const calls: string[] = [];
  await act(async () => root.render(<I18nProvider><ConversationResultRow result={{ sessionId: 'ses_1', title: 'Find this', titleRanges: [[0, 4]], directory: '/repo', archived: false, metadata: null, excerpt: { messageId: 'msg_1', role: 'user', snippet: 'a \uE000match\uE001', createdAt: 1 }, moreMatches: 1 }} meta="meta" onOpen={() => calls.push('open')} onOpenExcerpt={() => calls.push('excerpt')} onShowMoreMatches={() => calls.push('more')} /></I18nProvider>));
  expect(host.querySelector('[data-conversation-result="ses_1"] mark')?.textContent).toBe('Find');
  expect(host.querySelector('[data-conversation-title-action]')?.className).toContain('flex');
  expect(host.querySelector('[data-conversation-title]')?.className).toContain('min-w-0 truncate');
  expect(host.querySelector('[data-conversation-meta]')?.className).toContain('whitespace-nowrap');
  expect(host.querySelector('[data-conversation-excerpt-action]')?.className).toContain('min-w-0 overflow-hidden');
  expect(host.querySelector('[data-conversation-excerpt-action] mark')?.textContent).toBe('match');
  const buttons = [...host.querySelectorAll('button')];
  buttons.forEach((button) => button.click());
  expect(calls).toEqual(['open', 'excerpt', 'more']);
  await act(async () => root.unmount());
}));

test('status line reserves one line for every status', () => withDom(async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  for (const status of [{ kind: 'idle' }, { kind: 'off' }, { kind: 'unsupported' }, { kind: 'failed' }, { kind: 'too-short' }, { kind: 'loading' }, { kind: 'error' }, { kind: 'ready', indexing: null, lifecycleComplete: true, hasMore: false }] as const) {
    await act(async () => root.render(<I18nProvider><SearchStatusLine status={status} count={1} /></I18nProvider>));
    expect(host.querySelector('[data-search-status-line]')).not.toBeNull();
    expect(host.querySelector('[data-search-status-line]')?.className).toContain('h-5');
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  }
  await act(async () => root.unmount());
}));

test('status tooltip includes the full count and clipped message', () => withDom(async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => root.render(<I18nProvider><SearchStatusLine status={{ kind: 'off' }} count={2} /></I18nProvider>));
  expect(host.querySelector('[data-search-status-line]')?.getAttribute('title')).toBe('2 conversations · Message search is off. Titles and projects are still searched.');
  await act(async () => root.unmount());
}));

test('archived mobile rows label their lifecycle and keep activation actions separate', () => withDom(async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const calls: string[] = [];
  const result = { sessionId: 'ses_archived', title: 'Archived chat', titleRanges: [], directory: '/repo', archived: true, metadata: null, excerpt: { messageId: 'msg_archived', role: 'user' as const, snippet: 'matching text', createdAt: 1 }, moreMatches: 0 };
  const render = async (archived: boolean) => act(async () => root.render(<I18nProvider><ConversationResultRow result={{ ...result, archived }} mobile meta="repo" onOpen={() => calls.push('title')} onOpenExcerpt={() => calls.push('excerpt')} /></I18nProvider>));
  await render(true);
  expect(host.querySelector('[data-conversation-archived]')?.textContent).toBe('Archived');
  expect(host.querySelector('button button')).toBeNull();
  host.querySelector<HTMLButtonElement>('[data-conversation-title-action]')?.click();
  expect(calls).toEqual(['title']);
  host.querySelector<HTMLButtonElement>('[data-conversation-excerpt-action]')?.click();
  expect(calls).toEqual(['title', 'excerpt']);
  await render(false);
  expect(host.querySelector('[data-conversation-archived]')).toBeNull();
  await act(async () => root.unmount());
}));

test('ready status prioritizes indexing, then lifecycle incompleteness, then ready', () => withDom(async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  const cases = [
    { indexing: { done: 2, total: 10 }, lifecycleComplete: false, text: 'Indexing messages: 2 of 10' },
    { indexing: null, lifecycleComplete: false, text: 'Still reading which conversations are archived' },
    { indexing: null, lifecycleComplete: true, text: 'Message index ready' },
  ];
  for (const { text, ...state } of cases) {
    await act(async () => root.render(<I18nProvider><SearchStatusLine status={{ kind: 'ready', hasMore: false, ...state }} count={null} /></I18nProvider>));
    expect(host.querySelector('[data-search-status-line]')?.textContent).toBe(text);
    expect(host.querySelector('[data-search-status-line]')?.className).toContain('h-5');
  }
  await act(async () => root.unmount());
}));

test('grouped page errors announce the error ahead of ready indexing and lifecycle status in the same slot', () => withDom(async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  const render = (status: ContentSearchStatus) => act(async () => root.render(<I18nProvider><SearchStatusLine status={status} count={2} /></I18nProvider>));
  try {
    await render({ kind: 'error' });
    const slot = host.querySelector('[data-search-status-line]');
    const errorText = slot?.lastElementChild?.textContent;
    const countText = slot?.firstElementChild?.textContent;
    expect(errorText?.length).toBeGreaterThan(0);
    for (const state of [
      { indexing: { done: 2, total: 10 }, lifecycleComplete: false },
      { indexing: null, lifecycleComplete: false },
      { indexing: null, lifecycleComplete: true },
    ]) {
      await render({ kind: 'ready', hasMore: true, pageError: true, ...state });
      expect(slot?.lastElementChild?.textContent).toBe(errorText);
      expect(slot?.firstElementChild?.textContent).toBe(countText);
      expect(host.querySelector('[role="status"]')).toBe(slot);
      expect(slot?.getAttribute('aria-live')).toBe('polite');
      expect(slot?.className).toContain('h-5');
      expect(slot?.getAttribute('title')).toContain(errorText!);
      await render({ kind: 'ready', hasMore: true, pageError: false, ...state });
      expect(slot?.lastElementChild?.textContent).not.toBe(errorText);
    }
  } finally {
    await act(async () => root.unmount());
  }
}));
