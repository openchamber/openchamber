import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { SessionNodeItemProps } from './SessionNodeItem';
import type { SessionTreeItemProps } from './SessionTreeItem';
import { I18nProvider } from '@/lib/i18n';

mock.module('./SessionNodeItem', () => ({
  SessionNodeItem: ({ node, rowKey, handleDeleteSession }: SessionNodeItemProps) => (
    <button type="button" data-row-key={rowKey} onClick={() => handleDeleteSession(node.session)}>Archive</button>
  ),
}));

const noopStartSessionWorktreeMenuLoad: SessionTreeItemProps['startSessionWorktreeMenuLoad'] = () => ({
  cachedTargets: [],
  refreshTargets: Promise.resolve([]),
});

const session = (id: string): Session => ({
  id,
  projectID: 'project',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: 'Shared title',
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

describe('SessionTreeItem public behavior', () => {
  test('archive confirmation closes when its row disappears and stays closed when the row returns', async () => {
    const browser = new Window({ url: 'http://localhost' });
    const globals = {
      window: browser, document: browser.document, navigator: browser.navigator,
      localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
      fetch: async () => Response.error(),
      Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, HTMLIFrameElement: browser.HTMLIFrameElement,
      Event: browser.Event, CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      getComputedStyle: browser.getComputedStyle.bind(browser),
    };
    const descriptors = new Map(Object.entries(globals).map(([key, value]) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { value, configurable: true });
      return [key, descriptor] as const;
    }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const { SessionTreeItem } = await import('./SessionTreeItem');
    const noop = () => undefined;
    const rowProps: SessionTreeItemProps = {
      node: { session: session('same-session'), children: [], worktree: null },
      pinnedSessionIds: new Set(),
      expandedParents: new Set(),
      editingId: null,
      editingRowKey: null,
      setEditingId: noop,
      setEditingRowKey: noop,
      editTitle: '',
      setEditTitle: noop,
      toggleParent: noop,
      openSidebarMenuKey: null,
      setOpenSidebarMenuKey: noop,
      allowReselect: false,
      startFolderRename: noop,
      startSessionWorktreeMenuLoad: noopStartSessionWorktreeMenuLoad,
      mobileVariant: false,
      alwaysShowActions: false,
    };
    const render = (showPinned: boolean) => root.render(
      <I18nProvider>
        <SessionTreeItem {...rowProps} rowKey="chats" renderContext="tree-chat" />
        {showPinned ? <SessionTreeItem {...rowProps} rowKey="pinned" renderContext="mixed-compact" /> : null}
      </I18nProvider>,
    );
    const archiveDialogs = () => Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter((dialog) => dialog.textContent?.includes('Archive session?'));

    try {
      await act(async () => render(true));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-row-key="pinned"]')?.click());
      expect(archiveDialogs()).toHaveLength(1);
      await act(async () => render(false));
      expect(archiveDialogs()).toHaveLength(0);
      await act(async () => render(true));
      expect(archiveDialogs()).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
