import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { SessionRowOrderEntry } from '../sessions/sessionRowOrderUtils';

/**
 * Drives the real Ctrl/Cmd+A listener that `useSidebarBulkActions` installs.
 *
 * happy-dom provides real KeyboardEvent dispatch to the window listener; the
 * hook test DOM cannot deliver those events. No session row DOM exists in this
 * suite at all (`[data-session-row]` count is asserted as zero), so a passing
 * selection proves the row-order registry — not a DOM scan — supplies the ids.
 */

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  location: browser.location,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Node: browser.Node,
  customElements: browser.customElements,
  CSSStyleSheet: browser.CSSStyleSheet,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// React DOM detects input-event support when imported, so install the DOM first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useSessionMultiSelectStore } = await import('@/stores/useSessionMultiSelectStore');
const { SessionRowOrderProvider, useRegisterSessionRowOrder } = await import('../sessions/sessionRowOrder');
const { useSidebarBulkActions } = await import('./useSidebarBulkActions');

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) OpenChamberKeyboardTest/1.0';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) OpenChamberKeyboardTest/1.0';

const setUserAgent = (value: string): void => {
  Object.defineProperty(browser.navigator, 'userAgent', { configurable: true, value });
};

// Mirrors the real render order: a project segment and the Recent duplicate,
// plus a second scope used to prove the store scope filters the selection.
const PROJECT_SEGMENT: readonly SessionRowOrderEntry[] = [
  { id: 'ses_a', scopeKey: 'project', archived: false },
  { id: 'ses_b', scopeKey: 'project', archived: false },
];
const RECENT_SEGMENT: readonly SessionRowOrderEntry[] = [
  { id: 'ses_a', scopeKey: 'project', archived: false },
  { id: 'ses_c', scopeKey: 'project', archived: false },
];
const OTHER_SCOPE_SEGMENT: readonly SessionRowOrderEntry[] = [
  { id: 'ses_other', scopeKey: 'project-b', archived: false },
];

const noop = (): void => undefined;
const noFolderScopes = (): readonly { scopeKey: string; directory: string | null }[] => [];
const noFolder = (): null => null;
const noArchiveSessions = async (): Promise<{ archivedIds: string[]; failedIds: string[] }> => (
  { archivedIds: [], failedIds: [] }
);
const noUnarchiveSessions = async (): Promise<{ restoredIds: string[]; failedIds: string[] }> => (
  { restoredIds: [], failedIds: [] }
);
const noDeleteSessions = async (): Promise<{ deletedIds: string[]; failedIds: string[] }> => (
  { deletedIds: [], failedIds: [] }
);

const BulkActionsHarness = () => {
  useRegisterSessionRowOrder(0, PROJECT_SEGMENT);
  useRegisterSessionRowOrder(1, RECENT_SEGMENT);
  useRegisterSessionRowOrder(2, OTHER_SCOPE_SEGMENT);
  useSidebarBulkActions({
    isInlineEditing: false,
    showDeletionDialog: false,
    foldersMap: {},
    getFolderScopesForProject: noFolderScopes,
    addSessionsToFolder: noop,
    removeSessionsFromFolders: noop,
    createFolderAndStartRename: noFolder,
    archiveSessions: noArchiveSessions,
    unarchiveSessions: noUnarchiveSessions,
    deleteSessions: noDeleteSessions,
    setBulkDeleteConfirm: noop,
  });
  return null;
};

let root: Root | null = null;

const mountHarness = async (): Promise<void> => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nProvider>
        <SessionRowOrderProvider>
          <BulkActionsHarness />
        </SessionRowOrderProvider>
      </I18nProvider>,
    );
  });
};

const unmountHarness = async (): Promise<void> => {
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => mounted.unmount());
};

const enableSelectionMode = async (): Promise<void> => {
  await act(async () => {
    useSessionMultiSelectStore.getState().enable();
  });
};

const dispatchSelectAll = async (modifier: 'ctrl' | 'meta'): Promise<void> => {
  await act(async () => {
    browser.dispatchEvent(new browser.KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
      ctrlKey: modifier === 'ctrl',
      metaKey: modifier === 'meta',
    }));
  });
};

const selectedIds = (): string[] => [...useSessionMultiSelectStore.getState().selectedIds];

beforeEach(() => {
  setUserAgent(LINUX_UA);
});

afterEach(async () => {
  await unmountHarness();
  useSessionMultiSelectStore.getState().disable();
  browser.document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('sidebar bulk select-all keyboard wiring', () => {
  test('Ctrl+A selects every registered row in the resolved scope, including unmounted ids', async () => {
    await mountHarness();
    await enableSelectionMode();

    // The whole point of the registry: no row DOM exists anywhere here.
    expect(browser.document.querySelectorAll('[data-session-row]')).toHaveLength(0);

    await dispatchSelectAll('ctrl');

    // ses_a is duplicated by the Recent segment; ses_b and ses_c each come
    // from one segment and none of them were ever mounted.
    expect(selectedIds()).toEqual(['ses_a', 'ses_b', 'ses_c']);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project');
  });

  test('Cmd+A drives the meta branch on a Mac user agent', async () => {
    setUserAgent(MAC_UA);
    await mountHarness();
    await enableSelectionMode();

    await dispatchSelectAll('meta');

    expect(selectedIds()).toEqual(['ses_a', 'ses_b', 'ses_c']);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project');
  });

  test('a pre-set store scope restricts select-all to that scope only', async () => {
    await mountHarness();
    await act(async () => {
      const store = useSessionMultiSelectStore.getState();
      store.enable();
      store.toggleSelected('ses_other', 'project-b');
    });

    await dispatchSelectAll('ctrl');

    expect(selectedIds()).toEqual(['ses_other']);
    expect(useSessionMultiSelectStore.getState().scopeKey).toBe('project-b');
    expect(useSessionMultiSelectStore.getState().selectedIds.has('ses_a')).toBe(false);
  });

  test('unmount removes the keydown listener', async () => {
    await mountHarness();
    await enableSelectionMode();
    await dispatchSelectAll('ctrl');
    expect(selectedIds()).toEqual(['ses_a', 'ses_b', 'ses_c']);

    await unmountHarness();
    useSessionMultiSelectStore.getState().clear();
    expect(selectedIds()).toEqual([]);

    // A leaked listener would re-select the registry rows here.
    await dispatchSelectAll('ctrl');
    expect(selectedIds()).toEqual([]);
  });
});
