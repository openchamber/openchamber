import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { SyncProvider } from '@/sync/sync-context';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { SessionSidebarFolderItem } from './SessionSidebarFolderItem';

const createSdk = () => OpenCode.make({
  baseUrl: 'https://folder.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: '/repo', project: { id: 'project', directory: '/repo', canonical: '/repo' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

test('a collapsed virtual folder shows live and unread descendants without mounting them', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const originalSessions = useGlobalSessionsStore.getState();
  const session = (id: string, parentID?: string): Session => ({
    id, parentID, title: id, directory: '/repo', projectID: 'project', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  });
  const sessions = [{ session: session('parent'), worktree: null, children: [{ session: session('child', 'parent'), worktree: null, children: [] }] }];
  const render = (isCollapsed = true, archivedBucket = false) => root.render(
    <SyncProvider sdk={createSdk()} directory="">
      <I18nProvider><SessionSidebarFolderItem
        folder={{ id: 'folder', name: 'Folder', createdAt: 1, sessionIds: ['parent'] }}
        sessions={[]} activityNodes={sessions}
        isCollapsed={isCollapsed} archivedBucket={archivedBucket} renderBody={false}
        onToggle={() => undefined} onRename={() => undefined} onDelete={() => undefined}
      ><div data-hidden-session="child">Child session</div></SessionSidebarFolderItem></I18nProvider>
    </SyncProvider>,
  );
  const mocks = [
    spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
    spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
    spyOn(opencodeClient, 'getLocation').mockResolvedValue({
      directory: '/repo',
      project: { id: 'project', directory: '/repo', canonical: '/repo' },
    }),
    spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
    spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
  ];
  try {
    replaceGlobalSessionStatusById(new Map());
    useGlobalSessionsStore.getState().applySnapshot([session('parent'), session('child', 'parent')], []);
    await act(async () => render());
    await act(async () => replaceGlobalSessionStatusById(new Map([['child', { status: { type: 'busy' }, directory: '/repo' }]])));
    expect(container.querySelector('[aria-label="Session active"]')).not.toBeNull();
    expect(container.querySelector('[data-hidden-session]')).toBeNull();
    // A subtask's finished turn reports to its parent, never on its own.
    await act(async () => {
      replaceGlobalSessionStatusById(new Map());
      useGlobalSessionsStore.getState().upsertSession({ ...session('child', 'parent'), time: { created: 1, updated: 2, idle: 2 } });
      render();
    });
    expect(container.querySelector('[aria-label="Session active"]')).toBeNull();
    expect(container.querySelector('[aria-label="Unread updates"]')).toBeNull();
    await act(async () => useGlobalSessionsStore.getState().upsertSession({ ...session('parent'), time: { created: 1, updated: 3, idle: 3 } }));
    expect(container.querySelector('[aria-label="Unread updates"]')).not.toBeNull();
    await act(async () => render(false));
    expect(container.querySelector('[aria-label="Unread updates"]')).toBeNull();
    await act(async () => render(true, true));
    expect(container.querySelector('[aria-label="Unread updates"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    for (const mock of mocks) mock.mockRestore();
    replaceGlobalSessionStatusById(new Map());
    useGlobalSessionsStore.setState(originalSessions);
    container.remove();
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
