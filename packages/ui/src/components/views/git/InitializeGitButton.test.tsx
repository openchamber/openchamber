import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

// The real dialog portals out of the container; a passthrough keeps the
// confirmation in the rendered tree where the test can click it.
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

import type { Root } from 'react-dom/client';

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { toast } = await import('@/components/ui');
const { createWebAPIs } = await import('../../../../../web/src/api/index');
const { OpencodeApiError, opencodeClient } = await import('@/lib/opencode/client');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useGitStore } = await import('@/stores/useGitStore');
const { InitializeGitButton } = await import('./InitializeGitButton');

const DOM_GLOBAL_NAMES = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage',
  'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node,
    Element: win.Element, HTMLElement: win.HTMLElement, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    },
  };
};

const apis = createWebAPIs();

describe('InitializeGitButton', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;

  beforeEach(() => {
    dom = installDom();
    root = createRoot(dom.container);
    useDirectoryStore.setState({ homeDirectory: '/home/user' });
    useGitStore.setState({ nestedReposByRoot: new Map(), nestedRepoSelection: new Map() });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  const renderButton = async () => {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={apis}>
        <I18nProvider>
          <InitializeGitButton directory="/repo" />
        </I18nProvider>
      </RuntimeAPIContext.Provider>,
    ));
  };

  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent === label);

  const waitForButton = async (label: string) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const found = button(label);
      if (found) return found;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    throw new Error(`Missing ${label}`);
  };

  const click = async (element: HTMLButtonElement) => {
    await act(async () => { element.click(); });
  };

  test('asks before initializing when the scan could not check everything', async () => {
    useGitStore.setState({ nestedReposByRoot: new Map([['/repo', { repositories: [], complete: false }]]) });
    const initializeGit = spyOn(opencodeClient, 'initializeGit').mockImplementation(() => new Promise<void>(() => {}));
    try {
      await renderButton();
      await click(await waitForButton('Initialize Git'));
      expect(initializeGit.mock.calls).toEqual([]);
      await click(await waitForButton('Initialize anyway'));
      expect(initializeGit.mock.calls).toEqual([['/repo', { confirmShadowing: true }]]);
    } finally {
      initializeGit.mockRestore();
    }
  });

  test('asks before initializing when discovery found nested repositories', async () => {
    useGitStore.setState({ nestedReposByRoot: new Map([['/repo', { repositories: ['/repo/nested'], complete: true }]]) });
    const initializeGit = spyOn(opencodeClient, 'initializeGit').mockImplementation(() => new Promise<void>(() => {}));
    try {
      await renderButton();
      await click(await waitForButton('Initialize Git'));
      expect(initializeGit.mock.calls).toEqual([]);
      await click(await waitForButton('Initialize anyway'));
      expect(initializeGit.mock.calls).toEqual([['/repo', { confirmShadowing: true }]]);
    } finally {
      initializeGit.mockRestore();
    }
  });

  test('offers the confirmation when the server refuses, and retries with it', async () => {
    const initializeGit = spyOn(opencodeClient, 'initializeGit')
      .mockRejectedValueOnce(new OpencodeApiError('vcs.init', 'nested repositories exist below', {
        tag: 'VcsInitConfirmationRequiredError',
      }))
      .mockImplementation(() => new Promise<void>(() => {}));
    try {
      await renderButton();
      await click(await waitForButton('Initialize Git'));
      await click(await waitForButton('Initialize anyway'));
      expect(initializeGit.mock.calls).toEqual([
        ['/repo', undefined],
        ['/repo', { confirmShadowing: true }],
      ]);
    } finally {
      initializeGit.mockRestore();
    }
  });

  test('a declined refusal does not retry and shows no failure toast', async () => {
    const initializeGit = spyOn(opencodeClient, 'initializeGit')
      .mockRejectedValueOnce(new OpencodeApiError('vcs.init', 'nested repositories exist below', {
        tag: 'VcsInitConfirmationRequiredError',
      }));
    const failureToast = spyOn(toast, 'error').mockImplementation(() => 'error');
    try {
      await renderButton();
      await click(await waitForButton('Initialize Git'));
      await click(await waitForButton('Cancel'));
      expect(initializeGit.mock.calls.length).toBe(1);
      expect(button('Initialize anyway')).toBeUndefined();
      expect(failureToast.mock.calls.length).toBe(0);
    } finally {
      failureToast.mockRestore();
      initializeGit.mockRestore();
    }
  });

  test('initializes directly when discovery found nothing and checked everything', async () => {
    useGitStore.setState({ nestedReposByRoot: new Map([['/repo', { repositories: [], complete: true }]]) });
    const initializeGit = spyOn(opencodeClient, 'initializeGit').mockImplementation(() => new Promise<void>(() => {}));
    try {
      await renderButton();
      await click(await waitForButton('Initialize Git'));
      expect(initializeGit.mock.calls).toEqual([['/repo', undefined]]);
      expect(button('Initialize anyway')).toBeUndefined();
    } finally {
      initializeGit.mockRestore();
    }
  });
});
