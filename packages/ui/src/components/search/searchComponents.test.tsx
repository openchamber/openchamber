import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

import { ConversationResultRow } from './ConversationResultRow';
import { SearchMetaList } from './SearchMetaList';
import { SearchStatusMark } from './SearchStatusMark';
import { useSearchFailureText } from './searchStatusText';
import { effectiveSearchScope } from './searchScopes';
import { searchScopeQuery } from '@/lib/search/omniQuery';
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
  await act(async () => root.render(<I18nProvider><ConversationResultRow result={{ sessionId: 'ses_1', title: 'Find this', titleRanges: [[0, 4]], directory: '/repo', archived: false, updatedAt: 1, metadata: null, excerpt: { messageId: 'msg_1', role: 'user', snippet: 'a \uE000match\uE001', createdAt: 1 }, moreMatches: 1 }} leading={<i data-test-leading />} age="3d" context={{ ...EMPTY_CONVERSATION_CONTEXT, branchLabel: 'feature/search' }} onOpen={() => calls.push('open')} onOpenExcerpt={() => calls.push('excerpt')} onShowMoreMatches={() => calls.push('more')} /></I18nProvider>));
  expect(host.querySelector('[data-conversation-result="ses_1"] mark')?.textContent).toBe('Find');
  expect(host.querySelector('[data-conversation-title-action]')?.className).toContain('flex');
  expect(host.querySelector('[data-conversation-title]')?.className).toContain('truncate');
  // The location mark opens the title line and the age closes it.
  const titleLine = host.querySelector('[data-conversation-title]')?.parentElement;
  expect(titleLine?.firstElementChild?.hasAttribute('data-test-leading')).toBe(true);
  expect(titleLine?.lastElementChild?.textContent).toBe('3d');
  expect(host.querySelector('[data-search-meta-item="branch"] [dir="ltr"]')?.textContent).toBe('feature/search');
  expect(host.querySelector('[data-search-meta-icon]')?.getAttribute('role')).toBe('img');
  expect(host.querySelector('[data-conversation-excerpt-action]')?.className).toContain('truncate');
  expect(host.querySelector('[data-conversation-excerpt-author]')?.textContent).toBe('You:');
  expect(host.querySelector('[data-conversation-more-matches]')?.textContent).toBe('+1');
  expect(host.querySelector('button button')).toBeNull();
  expect(host.querySelector('[data-conversation-excerpt-action] mark')?.textContent).toBe('match');
  expect(host.textContent).not.toContain('·');
  const buttons = [...host.querySelectorAll('button')];
  buttons.forEach((button) => button.click());
  expect(calls).toEqual(['open', 'excerpt', 'more']);
  await act(async () => root.unmount());
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
  await act(async () => root.render(<I18nProvider><ConversationResultRow result={{ sessionId: 'ses_empty', title: 'Plain chat', titleRanges: [], directory: '/repo', archived: false, updatedAt: null, metadata: null, excerpt: null, moreMatches: 0 }} context={EMPTY_CONVERSATION_CONTEXT} onOpen={() => {}} onOpenExcerpt={() => {}} /></I18nProvider>));
  expect(host.querySelector('[data-search-meta]')).toBeNull();
  expect(host.querySelector('[data-search-meta-divider]')).toBeNull();
  expect(host.textContent).not.toContain('·');
  await act(async () => root.unmount());
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
    await act(async () => root.render(<I18nProvider><ConversationResultRow result={{ sessionId: 'ses_2', title: 'Title', titleRanges: [], directory: null, archived: true, updatedAt: null, metadata: null, excerpt: null, moreMatches: 0 }} onOpen={() => {}} onOpenExcerpt={() => {}} /></I18nProvider>));
    const title = host.querySelector('[data-conversation-title-action]');
    expect(title?.querySelector('div')).toBeNull();
    expect(title?.firstElementChild?.tagName).toBe('SPAN');
    // Lists say Archived once, in their caption; a row carries no lifecycle tag, age or meta line it was not given.
    expect(host.querySelector('[data-conversation-archived]')).toBeNull();
    expect(host.querySelector('[data-conversation-age]')).toBeNull();
    expect(host.querySelector('[data-search-meta]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
}));

const renderStatus = async (status: ContentSearchStatus) => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let text: string | null = null;
  const Probe = () => { text = useSearchFailureText(status); return <SearchStatusMark status={status} />; };
  await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
  const mark = host.querySelector('[data-search-status]');
  const result = { tone: mark?.getAttribute('data-search-status') ?? null, label: mark?.getAttribute('aria-label') ?? null, text };
  await act(async () => root.unmount());
  return result;
};
const ready = (overrides: Partial<Extract<ContentSearchStatus, { kind: 'ready' }>> = {}): ContentSearchStatus => ({ kind: 'ready', indexing: null, lifecycleComplete: true, hasMore: false, ...overrides });

test('a search that is working or went fine shows no status mark', () => withDom(async () => {
  for (const status of [{ kind: 'idle' }, { kind: 'off' }, { kind: 'unsupported' }, { kind: 'too-short' }, { kind: 'loading' }, ready(), ready({ indexing: { done: 2, total: 9 } }), ready({ lifecycleComplete: false })] satisfies ContentSearchStatus[]) {
    expect(await renderStatus(status)).toEqual({ tone: null, label: null, text: null });
  }
}));

test('the status mark shows only a failed message search', () => withDom(async () => {
  expect((await renderStatus({ kind: 'failed' })).tone).toBe('error');
  expect((await renderStatus({ kind: 'error' })).tone).toBe('error');
  // A failed page shows even while the index is still filling.
  expect((await renderStatus(ready({ pageError: true, indexing: { done: 2, total: 9 }, lifecycleComplete: false }))).tone).toBe('error');
}));

test('an author scope searches that author\'s messages only, and a scope the search cannot honour falls back to everything', () => {
  expect(searchScopeQuery('everything')).toEqual({ searchIn: 'everything', author: 'any' });
  expect(searchScopeQuery('titles')).toEqual({ searchIn: 'titles', author: 'any' });
  expect(searchScopeQuery('user')).toEqual({ searchIn: 'messages', author: 'user' });
  expect(searchScopeQuery('reasoning')).toEqual({ searchIn: 'messages', author: 'reasoning' });
  expect(effectiveSearchScope('reasoning', ['everything', 'titles', 'user', 'assistant'])).toBe('everything');
  expect(effectiveSearchScope('user', [])).toBe('everything');
  expect(effectiveSearchScope('titles', ['everything', 'titles', 'user', 'assistant'])).toBe('titles');
});

test('a failed messages-only search does not promise a title search', () => withDom(async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const label = async (scope: 'everything' | 'user') => {
    await act(async () => root.render(<I18nProvider><SearchStatusMark status={{ kind: 'error' }} scope={scope} /></I18nProvider>));
    return host.querySelector('[data-search-status]')?.getAttribute('aria-label');
  };
  expect(await label('everything')).toBe("Couldn't search messages. Titles and projects are still searched.");
  expect(await label('user')).toBe("Couldn't search messages.");
  await act(async () => root.unmount());
}));
