import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { Project } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const browser = new Window({ url: 'http://localhost:3000' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => { throw new Error('Directory availability is unknown in this test'); },
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const { createRoot } = await import('react-dom/client');
const { createWebAPIs } = await import('../../../../web/src/api/index');
const { OpenCodeProjectsImport } = await import('./OpenCodeProjectsImport');
const originalProjectsState = useProjectsStore.getState();
const originalDirectoryState = useDirectoryStore.getState();
const originalGlobalSyncState = useGlobalSyncStore.getState();
let root: Root;
let host: HTMLDivElement;
let claimCount: number;

const openCodeProject = (worktree: string): Project => ({
  id: `project:${worktree}`,
  worktree,
  sandboxes: [],
  time: { created: 1, updated: 1 },
});

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  claimCount = 0;
  Object.assign(browser, {
    __OPENCHAMBER_API_BASE_URL__: 'http://localhost:3000',
    __OPENCHAMBER_LOCAL_ORIGIN__: 'http://localhost:3000',
  });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:3000', runtimeKey: 'local' });
  useProjectsStore.setState({ projects: [] });
  useDirectoryStore.setState({ homeDirectory: '/home/user' });
  useGlobalSyncStore.getState().actions.set({
    hasLoadedProjects: true,
    projects: [openCodeProject('/home/user/repo-a'), openCodeProject('/home/user/repo-b')],
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  useProjectsStore.setState(originalProjectsState);
  useDirectoryStore.setState(originalDirectoryState);
  useGlobalSyncStore.setState(originalGlobalSyncState);
  document.body.replaceChildren();
});

test('does not reopen the automatic prompt when project changes recheck candidates', async () => {
  const apis = createWebAPIs();
  apis.openCodeProjectImportPrompt = {
    claim: async () => {
      claimCount += 1;
      return 'claimed';
    },
  };

  await act(async () => root.render(
    <React.StrictMode>
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <OpenCodeProjectsImport />
        </RuntimeAPIContext.Provider>
      </I18nProvider>
    </React.StrictMode>,
  ));
  await act(settle);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2100)));
  expect(document.querySelector('[data-slot="dialog-content"]')?.textContent).toContain('Import projects from OpenCode');
  expect(claimCount).toBe(1);

  const cancelButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Cancel');
  if (!cancelButton) throw new Error('Prompt cancel button was not rendered');
  await act(async () => cancelButton.click());
  expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();

  await act(async () => {
    useProjectsStore.setState({ projects: [{ id: 'repo-a', path: '/home/user/repo-a' }] });
    await settle();
  });
  await act(settle);

  expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  expect(claimCount).toBe(1);

  await act(async () => {
    useProjectsStore.setState({ projects: [] });
    await settle();
  });
  await act(settle);

  expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  expect(claimCount).toBe(1);
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
