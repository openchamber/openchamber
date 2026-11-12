import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { DirectoryListResult } from '@/lib/api/types';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';

const PROJECT = '/repo';
const SPACE = '/spaces/a1b2c3d4e5f6/repo';

test('a draft waiting for a new space lists nothing of this computer\'s while the space is made, then the space, with its tabs kept in the draft\'s panel', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // The tree draws only the rows inside its scroller, which happy-dom gives no size.
  for (const name of ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth']) {
    Object.defineProperty(dom.HTMLElement.prototype, name, { configurable: true, get: () => 600 });
  }
  // Anything else the tree reads (git status, the home folder) never answers.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { useSpacesStore } = await import('@/lib/spaces/spaces-store');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { noteSpaceCreationRequest, resetSpaceCreationRequests } = await import('@/lib/spaces/space-creation-requests');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { OpenCode } = await import('@opencode/client');
  const { SidebarFilesTree } = await import('./SidebarFilesTree');
  // Bootstrap stays pending: the tree reads only the stores this test sets.
  const sdk = OpenCode.make({ baseUrl: 'http://tree.test', fetch: () => new Promise<Response>(() => undefined) });

  const listed: string[] = [];
  const web = createWebAPIs();
  const apis = {
    ...web,
    files: {
      ...web.files,
      listDirectory: async (path: string): Promise<DirectoryListResult> => {
        listed.push(path);
        return { directory: path, entries: [{ name: 'logo.png', path: `${path}/logo.png`, isDirectory: false }] };
      },
    },
  };

  const space: SpaceEntry = {
    id: 'a1b2c3d4e5f6', name: 'Fix login', placeId: 'docker', machine: null,
    projectDirectory: PROJECT, projectFolder: { path: PROJECT, found: null }, directory: SPACE,
    state: 'preparing', stoppedIdle: false, step: 'creating', failure: null, network: { mode: 'allowlist', domains: [] },
    grants: [], access: null, needsAccess: [], accessFailures: [], damage: null, setup: null,
  };
  // As "Create space" leaves it: the draft stays on the project's folder while it waits for the space.
  useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: PROJECT, pendingWorktreeRequestId: 'worktree_space', preserveDirectoryOverride: true });
  noteSpaceCreationRequest('worktree_space', space.id);
  useSpacesStore.getState().addJourneyEntry(space);

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={PROJECT}>
        <I18nProvider><RuntimeAPIContext.Provider value={apis}><SidebarFilesTree /></RuntimeAPIContext.Provider></I18nProvider>
      </SyncProvider>,
    ));
    await flush();
    expect(container.textContent).toContain('Preparing isolated space');
    expect(listed).toEqual([]);

    await act(async () => useSpacesStore.getState().addJourneyEntry({ ...space, state: 'running', step: null }));
    await flush();
    expect(listed).toEqual([SPACE]);
    const row = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('logo.png'));
    if (!row) throw new Error('The space\'s file is not listed');

    await act(async () => row.click());
    await flush();
    // The file opens in the panel on screen, the draft's, and it is the space's file.
    const tabs = useUIStore.getState().contextPanelByDirectory[PROJECT]?.tabs ?? [];
    expect(tabs.filter((tab) => tab.mode === 'file').map((tab) => tab.targetPath)).toEqual([`${SPACE}/logo.png`]);
    expect(useUIStore.getState().contextPanelByDirectory[SPACE]).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    resetSpaceCreationRequests();
    useSpacesStore.getState().resetForRuntimeSwitch();
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
