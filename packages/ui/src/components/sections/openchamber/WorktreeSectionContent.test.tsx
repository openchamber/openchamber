import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { WorktreeMetadata } from '@/types/worktree';

const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
type Root = ReturnType<typeof createRoot>;
for (const [name, descriptor] of previousRendererGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

const project = { id: 'path:/repo', path: '/repo' };
const kept: WorktreeMetadata = {
  path: '/repo-kept',
  projectDirectory: '/repo',
  branch: 'kept',
  label: 'kept-worktree',
};
const removed: WorktreeMetadata = {
  path: '/repo-removed',
  projectDirectory: '/repo',
  branch: 'removed',
  label: 'removed-worktree',
};

let listedWorktrees: WorktreeMetadata[] = [kept, removed];
let currentSessions: Array<{ id: string }> = [{ id: 'session-in-removed' }];

const actualGitApi = await import('@/lib/gitApi');
mock.module('@/lib/gitApi', () => ({
  ...actualGitApi,
  checkIsGitRepository: async () => true,
}));

const actualWorktreeManager = await import('@/lib/worktrees/worktreeManager');
mock.module('@/lib/worktrees/worktreeManager', () => ({
  ...actualWorktreeManager,
  listProjectWorktrees: async () => listedWorktrees,
}));

const actualOpenchamberConfig = await import('@/lib/openchamberConfig');
mock.module('@/lib/openchamberConfig', () => ({
  ...actualOpenchamberConfig,
  getProjectSetup: async () => ({
    personal: { setupWorktree: [], setupWorktreeMode: 'append' },
    shared: { setupWorktree: [], path: '' },
    trust: { hash: null, trusted: false },
    setupWorktreeWait: false,
  }),
  saveWorktreeSetupCommands: async () => true,
  saveWorktreeSetupWaitEnabled: async () => true,
  updateProjectSetup: async () => true,
  updateSharedProjectSetup: async () => true,
}));

mock.module('@/lib/sharedTrustConfirmation', () => ({
  resetSharedSetupTrust: async () => false,
}));

const actualSyncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...actualSyncContext,
  useSessions: () => currentSessions,
}));

mock.module('@/lib/device', () => ({
  useDeviceInfo: () => ({ isMobile: false, isTablet: false }),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

const { I18nProvider } = await import('@/lib/i18n');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { WorktreeSectionContent } = await import('./WorktreeSectionContent');

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'KeyboardEvent',
  'Event',
  'HTMLIFrameElement',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    KeyboardEvent: happyWindow.KeyboardEvent,
    Event: happyWindow.Event,
    HTMLIFrameElement: happyWindow.HTMLIFrameElement,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      happyWindow.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const waitForText = async (container: HTMLElement, predicate: (text: string) => boolean, label: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate(container.textContent ?? '')) {
      return;
    }
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error(`${label}: ${container.textContent}`);
};

describe('WorktreeSectionContent manage list', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;

  beforeEach(() => {
    listedWorktrees = [kept, removed];
    currentSessions = [{ id: 'session-in-removed' }];
    useSessionUIStore.setState({
      availableWorktrees: [kept, removed],
      availableWorktreesByProject: new Map([['/repo', [kept, removed]]]),
    });
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
    useSessionUIStore.setState({
      availableWorktrees: [],
      availableWorktreesByProject: new Map(),
    });
  });

  test('drops a deleted worktree after remove updates the store, even when sessionsKey already refreshed', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <WorktreeSectionContent projectRef={project} sections="list-only" />
        </I18nProvider>,
      );
    });

    await waitForText(
      dom.container,
      (text) => text.includes('kept-worktree') && text.includes('removed-worktree'),
      'expected both worktrees after initial load',
    );

    // Archive runs first: sessionsKey refreshes while git still lists the deleted worktree.
    currentSessions = [];
    await act(async () => {
      root.render(
        <I18nProvider>
          <WorktreeSectionContent projectRef={project} sections="list-only" />
        </I18nProvider>,
      );
    });
    await waitForText(
      dom.container,
      (text) => text.includes('removed-worktree'),
      'expected stale worktree to remain after the early sessionsKey refresh',
    );

    listedWorktrees = [kept];
    await act(async () => {
      useSessionUIStore.setState({
        availableWorktrees: [kept],
        availableWorktreesByProject: new Map([['/repo', [kept]]]),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitForText(
      dom.container,
      (text) => text.includes('kept-worktree') && !text.includes('removed-worktree'),
      'expected deleted worktree to leave the list after the store update',
    );
    expect(dom.container.textContent).toContain('kept-worktree');
    expect(dom.container.textContent).not.toContain('removed-worktree');
  });
});
