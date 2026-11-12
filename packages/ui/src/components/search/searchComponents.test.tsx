import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

import { ConversationResultRow } from './ConversationResultRow';
import { SearchMetaList } from './SearchMetaList';
import { SearchStatusLine } from './SearchStatusLine';
import { SearchFilterChips } from './SearchFilterChips';
import { searchFilterChipKeys } from './searchFilterChipKeys';
import { EMPTY_CONVERSATION_CONTEXT, conversationContextFromLocation, type ConversationContextInput } from './conversationResultContext';
import { conversationContextItems } from './conversationContextItems';
import type { SidebarSessionLocation } from '@/components/session/sidebar/recent/sessionLocation';
import { I18nProvider } from '@/lib/i18n';
import type { ContentSearchStatus } from '@/hooks/useConversationSearch';
import type { ConversationResultContext } from './conversationResultContext';

const kindLabels = { project: 'Project', folder: 'Folder', branch: 'Branch', space: 'Space' };

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

test('conversation row marks title and excerpt, renders context, and routes row actions', () => withDom(async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const calls: string[] = [];
  await act(async () => root.render(<I18nProvider><ConversationResultRow result={{ sessionId: 'ses_1', title: 'Find this', titleRanges: [[0, 4]], directory: '/repo', archived: false, metadata: null, excerpt: { messageId: 'msg_1', role: 'user', snippet: 'a \uE000match\uE001', createdAt: 1 }, moreMatches: 1 }} context={{ ...EMPTY_CONVERSATION_CONTEXT, branchLabel: 'feature/search' }} onOpen={() => calls.push('open')} onOpenExcerpt={() => calls.push('excerpt')} onShowMoreMatches={() => calls.push('more')} /></I18nProvider>));
  expect(host.querySelector('[data-conversation-result="ses_1"] mark')?.textContent).toBe('Find');
  expect(host.querySelector('[data-conversation-title-action]')?.className).toContain('flex');
  expect(host.querySelector('[data-conversation-title]')?.className).toContain('min-w-0 truncate');
  expect(host.querySelector('[data-search-meta-item="branch"] [dir="ltr"]')?.textContent).toBe('feature/search');
  expect(host.querySelector('[data-search-meta-icon]')?.getAttribute('role')).toBe('img');
  expect(host.querySelector('[data-conversation-excerpt-action]')?.className).toContain('min-w-0 overflow-hidden');
  expect(host.querySelector('[data-conversation-excerpt-author]')?.textContent).toBe('You');
  expect(host.querySelector('[data-conversation-excerpt-action] mark')?.textContent).toBe('match');
  expect(host.textContent).not.toContain('·');
  const buttons = [...host.querySelectorAll('button')];
  buttons.forEach((button) => button.click());
  expect(calls).toEqual(['open', 'excerpt', 'more']);
  await act(async () => root.unmount());
}));

test('filter chips render removable non-default filters in their display order', () => withDom(async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const removed: string[] = [];
  try {
    const filters = { project: '/repos/alpha', worktree: '/repos/alpha/feature', lifecycle: 'archived' as const, searchIn: 'titles' as const, author: 'assistant' as const, category: 'sessions' as const };
    expect(searchFilterChipKeys(filters, { lifecycle: 'active', searchIn: 'everything', author: 'any' })).toEqual(['project', 'worktree', 'lifecycle', 'searchIn', 'author']);
    await act(async () => root.render(<I18nProvider><SearchFilterChips filters={filters} defaults={{ lifecycle: 'active', searchIn: 'everything', author: 'any' }} projectOptions={[{ value: '/repos/alpha', label: 'Alpha' }]} worktreeOptions={[{ value: '/repos/alpha/feature', label: 'Feature branch' }]} onRemove={(key) => removed.push(key)} /></I18nProvider>));
    expect([...host.querySelectorAll<HTMLElement>('[data-search-filter-chip]')].map((chip) => chip.dataset.searchFilterChip)).toEqual(['project', 'worktree', 'lifecycle', 'searchIn', 'author']);
    expect(host.querySelector('[data-search-filter-chip="project"] [title]')?.getAttribute('title')).toBe('/repos/alpha');
    expect(host.querySelector('[data-search-filter-chip="project"]')?.textContent).toContain('Alpha');
    expect(host.querySelector('[data-search-filter-chip="worktree"]')?.textContent).toContain('Feature branch');
    const remove = host.querySelector<HTMLButtonElement>('[data-search-filter-chip-remove="worktree"]');
    expect(remove?.getAttribute('aria-label')).toBe('Remove filter: Feature branch');
    await act(async () => remove?.click());
    expect(removed).toEqual(['worktree']);
    await act(async () => root.render(<I18nProvider><SearchFilterChips filters={{ lifecycle: 'active', searchIn: 'everything', author: 'any', category: 'sessions' }} defaults={{ lifecycle: 'active', searchIn: 'everything', author: 'any' }} onRemove={() => {}} /></I18nProvider>));
    expect(host.querySelector('[data-search-filter-chips]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
}));

test('context fields render in their specified order and direction', () => withDom(async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  const cases: Array<{ name: string; context: ConversationResultContext; keys: string[]; directions: Array<'auto' | 'ltr'>; iconLabels: string[] }> = [
    { name: 'project', context: { ...EMPTY_CONVERSATION_CONTEXT, project: { id: 'project_1', label: 'Project' } }, keys: ['project'], directions: ['auto'], iconLabels: ['Project'] },
    { name: 'folder', context: { ...EMPTY_CONVERSATION_CONTEXT, folderLabel: 'Unregistered folder' }, keys: ['folder'], directions: ['auto'], iconLabels: ['Folder'] },
    { name: 'space replaces branch', context: { ...EMPTY_CONVERSATION_CONTEXT, spaceLabel: 'Isolated space', branchLabel: 'ignored' }, keys: ['space'], directions: ['auto'], iconLabels: ['Space'] },
    { name: 'branch replaces worktree folder', context: { ...EMPTY_CONVERSATION_CONTEXT, branchLabel: 'feature/search', worktreeFolder: 'ignored' }, keys: ['branch'], directions: ['ltr'], iconLabels: ['Branch'] },
    { name: 'worktree folder', context: { ...EMPTY_CONVERSATION_CONTEXT, worktreeFolder: 'worktree-folder' }, keys: ['worktree-folder'], directions: ['ltr'], iconLabels: ['Folder'] },
    { name: 'full context and extras', context: { project: { id: 'project_1', label: 'Project' }, folderLabel: 'ignored', spaceLabel: null, branchLabel: 'feature/search', worktreeFolder: 'ignored', extras: [{ key: 'parent', text: 'Parent chat', dir: 'auto', priority: 'yield' }, { key: 'date', text: 'Today', dir: 'auto', priority: 'keep' }] }, keys: ['project', 'branch', 'parent', 'date'], directions: ['auto', 'ltr', 'auto', 'auto'], iconLabels: ['Project', 'Branch'] },
  ];
  for (const { context, keys, directions, iconLabels } of cases) {
    await act(async () => root.render(<SearchMetaList items={conversationContextItems(context, kindLabels)} />));
    expect([...host.querySelectorAll<HTMLElement>('[data-search-meta-item]')].map((item) => item.dataset.searchMetaItem)).toEqual(keys);
    expect([...host.querySelectorAll<HTMLElement>('[data-search-meta-item] > span:last-child')].map((item) => item.dir)).toEqual(directions);
    expect([...host.querySelectorAll('[data-search-meta-icon][role="img"]')].map((icon) => icon.getAttribute('aria-label'))).toEqual(iconLabels);
  }
  expect(host.querySelectorAll('[data-search-meta-divider][aria-hidden="true"]')).toHaveLength(2);
  await act(async () => root.unmount());
}));

test('empty context does not render metadata or a separator', () => withDom(async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => root.render(<I18nProvider><ConversationResultRow result={{ sessionId: 'ses_empty', title: 'Plain chat', titleRanges: [], directory: '/repo', archived: false, metadata: null, excerpt: null, moreMatches: 0 }} context={EMPTY_CONVERSATION_CONTEXT} onOpen={() => {}} onOpenExcerpt={() => {}} /></I18nProvider>));
  expect(host.querySelector('[data-search-meta]')).toBeNull();
  expect(host.querySelector('[data-search-meta-divider]')).toBeNull();
  expect(host.textContent).not.toContain('·');
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

test('status tooltip contains only the clipped status message', () => withDom(async () => {
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => root.render(<I18nProvider><SearchStatusLine status={{ kind: 'off' }} count={2} /></I18nProvider>));
  expect(host.querySelector('[data-search-status-line]')?.getAttribute('title')).toBe('Message search is off. Titles and projects are still searched.');
  await act(async () => root.unmount());
}));

test('archived mobile rows label their lifecycle and keep activation actions separate', () => withDom(async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const calls: string[] = [];
  const result = { sessionId: 'ses_archived', title: 'Archived chat', titleRanges: [], directory: '/repo', archived: true, metadata: null, excerpt: { messageId: 'msg_archived', role: 'user' as const, snippet: 'matching text', createdAt: 1 }, moreMatches: 0 };
  const render = async (archived: boolean) => act(async () => root.render(<I18nProvider><ConversationResultRow result={{ ...result, archived }} mobile context={EMPTY_CONVERSATION_CONTEXT} onOpen={() => calls.push('title')} onOpenExcerpt={() => calls.push('excerpt')} /></I18nProvider>));
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

const HOME = '/home/me';
const CHAT_DIRECTORY = `${HOME}/.config/openchamber/chats/ses_chat`;
const locationOf = (overrides: Partial<SidebarSessionLocation>): SidebarSessionLocation => ({
  projectId: 'p', groupDirectory: '/repo', projectLabel: 'repo', branchLabel: null, inSpace: false, worktree: null, ...overrides,
});
const contextOf = (input: Partial<ConversationContextInput>) => conversationContextFromLocation({
  location: null, directory: null, project: null, projectRoot: '/repo', homeDirectory: HOME, ...input,
});

test('a chat gets no context, and neither does a result with no directory', () => {
  expect(contextOf({ directory: CHAT_DIRECTORY })).toEqual(EMPTY_CONVERSATION_CONTEXT);
  expect(contextOf({ directory: null })).toEqual(EMPTY_CONVERSATION_CONTEXT);
});

test('an unregistered folder shows its name, with the absolute path on hover', () => {
  const context = contextOf({ directory: '/work/tool' });
  expect(context).toMatchObject({ folderLabel: 'tool', folderPath: '/work/tool', project: null, branchLabel: null });
  const items = conversationContextItems(context, kindLabels);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ key: 'folder', text: 'tool', title: '/work/tool' });
});

test('a deleted worktree shows its folder only when no branch is known and it is not the project root', () => {
  const worktree: SidebarSessionLocation['worktree'] = { path: '/wt/fix-search', projectDirectory: '/repo', branch: '', label: 'fix-search' };
  expect(contextOf({ location: locationOf({ worktree }), directory: '/wt/fix-search/src' })).toMatchObject({ worktreeFolder: 'fix-search', worktreePath: '/wt/fix-search' });
  expect(contextOf({ location: locationOf({ worktree, branchLabel: 'feature' }), directory: '/wt/fix-search' })).toMatchObject({ worktreeFolder: null, branchLabel: 'feature' });
  expect(contextOf({ location: locationOf({}), directory: '/repo' })).toMatchObject({ worktreeFolder: null, branchLabel: null });
});

test('an isolated space replaces the branch', () => {
  const context = contextOf({ location: locationOf({ inSpace: true, branchLabel: 'Review space' }), directory: '/spaces/review' });
  expect(context).toMatchObject({ branchLabel: null, spaceLabel: 'Review space' });
  expect(conversationContextItems(context, kindLabels).map((item) => item.key)).toEqual(['space']);
});

test('a folder override replaces the location items and the extras keep their order', () => {
  const context = conversationContextFromLocation({
    location: locationOf({ branchLabel: 'main' }), directory: '/deleted/space', project: { id: 'p', label: 'Repo' }, projectRoot: '/repo', homeDirectory: HOME,
    folderOverride: 'Deleted space', extras: [{ key: 'parent', text: 'Parent', dir: 'auto' }, { key: 'date', text: 'Today', dir: 'auto' }],
  });
  expect(conversationContextItems(context, kindLabels).map((item) => item.key)).toEqual(['folder', 'parent', 'date']);
  expect(context).toMatchObject({ project: null, folderLabel: 'Deleted space', branchLabel: null });
});

test('the title button holds a span, not a div, for its first line', () => withDom(async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider><ConversationResultRow result={{ sessionId: 'ses_2', title: 'Title', titleRanges: [], directory: null, archived: true, metadata: null, excerpt: null, moreMatches: 0 }} context={EMPTY_CONVERSATION_CONTEXT} onOpen={() => {}} onOpenExcerpt={() => {}} /></I18nProvider>));
    const title = host.querySelector('[data-conversation-title-action]');
    expect(title?.querySelector('div')).toBeNull();
    expect(title?.firstElementChild?.tagName).toBe('SPAN');
    expect(title?.querySelector('[data-conversation-archived]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
}));
