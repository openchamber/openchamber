import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { SessionTabMenuComponents } from './SessionTabsStrip';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { toast } = await import('@/components/ui');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useUIStore } = await import('@/stores/useUIStore');
const { formatShortcutForDisplay } = await import('@/lib/shortcuts');
const { HeaderSessionArchiveMenuItem } = await import('./HeaderSessionArchiveMenuItem');
const initialSessions = useGlobalSessionsStore.getState();
const initialUI = useSessionUIStore.getState();
const initialShortcutOverrides = useUIStore.getState().shortcutOverrides;
const Item: SessionTabMenuComponents['Item'] = (props) => <button {...props} />;
const session = (id: string, archived?: number): Session => ({
  id, title: id, directory: '/workspace', projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1, archived },
});
let root: Root;
let archiveRequests: number;
let restoreRequests: string[];
const successMessages: React.ReactNode[] = [];
const errorMessages: React.ReactNode[] = [];
const successToast = spyOn(toast, 'success').mockImplementation((message) => successMessages.push(message));
const errorToast = spyOn(toast, 'error').mockImplementation((message) => errorMessages.push(message));

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  archiveRequests = 0;
  restoreRequests = [];
  successMessages.length = 0;
  errorMessages.length = 0;
  useSessionUIStore.setState({
    currentSessionId: 'another-session',
    unarchiveSession: async (id) => {
      restoreRequests.push(id);
      useGlobalSessionsStore.getState().upsertSession(session(id, 0));
      return true;
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  useGlobalSessionsStore.setState(initialSessions);
  useSessionUIStore.setState(initialUI);
  useUIStore.setState({ shortcutOverrides: initialShortcutOverrides });
  document.body.replaceChildren();
});

afterAll(async () => {
  successToast.mockRestore();
  errorToast.mockRestore();
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const renderMenuItem = async () => {
  await act(async () => root.render(
    <I18nProvider>
      <HeaderSessionArchiveMenuItem sessionId="target" Item={Item} onArchive={() => { archiveRequests += 1; }} />
    </I18nProvider>,
  ));
  const button = document.querySelector('button');
  if (!button) throw new Error('Archive menu item missing');
  return button;
};

test('archive hint follows rebindings and appears only for the current active session', async () => {
  useGlobalSessionsStore.getState().upsertSession(session('target'));
  useSessionUIStore.setState({ currentSessionId: 'target' });
  useUIStore.setState({ shortcutOverrides: { archive_current_session: 'mod+shift+x' } });
  const button = await renderMenuItem();
  expect(button.querySelector('span')?.textContent).toBe(formatShortcutForDisplay('mod+shift+x'));
  await act(async () => useUIStore.setState({ shortcutOverrides: { archive_current_session: 'alt+a' } }));
  expect(button.querySelector('span')?.textContent).toBe(formatShortcutForDisplay('alt+a'));
  await act(async () => useUIStore.setState({ shortcutOverrides: { archive_current_session: '__unassigned__' } }));
  expect(button.textContent).toBe('Archive');
  expect(button.querySelector('span')).toBeNull();
  await act(async () => useSessionUIStore.setState({ currentSessionId: 'another-session' }));
  expect(button.textContent).toBe('Archive');
  await act(async () => {
    useSessionUIStore.setState({ currentSessionId: 'target' });
    useGlobalSessionsStore.getState().upsertSession(session('target', 2));
  });
  expect(button.textContent).toBe('Restore');
});

for (const archived of [undefined, 0]) {
  test(`active sessions with archive timestamp ${archived} keep archive confirmation`, async () => {
    useGlobalSessionsStore.getState().upsertSession(session('target', archived));
    const button = await renderMenuItem();
    expect(button.textContent).toBe('Archive');
    expect(button.querySelector('use')?.getAttribute('href')).toBe('#oc-inbox-archive');
    await act(async () => button.click());
    expect(archiveRequests).toBe(1);
    expect(restoreRequests).toEqual([]);
  });
}

test('restores the menu session, including an inactive tab, and reacts to archive changes', async () => {
  useGlobalSessionsStore.getState().upsertSession(session('target', 2));
  const button = await renderMenuItem();
  expect(button.textContent).toBe('Restore');
  expect(button.querySelector('use')?.getAttribute('href')).toBe('#oc-inbox-unarchive');
  await act(async () => button.click());
  expect(restoreRequests).toEqual(['target']);
  expect(archiveRequests).toBe(0);
  expect(useSessionUIStore.getState().currentSessionId).toBe('another-session');
  expect(successMessages).toEqual(['Session restored']);
  expect(errorMessages).toEqual([]);
  expect(button.textContent).toBe('Archive');
  await act(async () => useGlobalSessionsStore.getState().upsertSession(session('target', 3)));
  expect(button.textContent).toBe('Restore');
});

test('waits for confirmation and leaves a failed restore available for retry', async () => {
  useGlobalSessionsStore.getState().upsertSession(session('target', 2));
  let failRestore: (() => void) | undefined;
  useSessionUIStore.setState({
    unarchiveSession: (id) => {
      restoreRequests.push(id);
      return new Promise<boolean>((resolve) => { failRestore = () => resolve(false); });
    },
  });
  const button = await renderMenuItem();
  await act(async () => button.click());
  expect(button.textContent).toBe('Restore');
  expect(successMessages).toEqual([]);
  expect(errorMessages).toEqual([]);
  await act(async () => failRestore?.());
  expect(restoreRequests).toEqual(['target']);
  expect(archiveRequests).toBe(0);
  expect(errorMessages).toEqual(['Failed to restore session']);
  expect(successMessages).toEqual([]);
  expect(useGlobalSessionsStore.getState().entityById.get('target')?.time.archived).toBe(2);
  expect(button.textContent).toBe('Restore');
});

test('offers no restore for an archived subsession whose parent is archived or unknown', async () => {
  useGlobalSessionsStore.getState().upsertSession({ ...session('target', 2), parentID: 'parent' });
  await act(async () => root.render(
    <I18nProvider>
      <HeaderSessionArchiveMenuItem sessionId="target" Item={Item} onArchive={() => { archiveRequests += 1; }} />
    </I18nProvider>,
  ));
  expect(document.querySelector('button')).toBeNull();
  await act(async () => { useGlobalSessionsStore.getState().upsertSession(session('parent', 3)); });
  expect(document.querySelector('button')).toBeNull();
});

test('offers restore for an archived subsession whose parent is active', async () => {
  useGlobalSessionsStore.getState().upsertSession(session('parent', 0));
  useGlobalSessionsStore.getState().upsertSession({ ...session('target', 2), parentID: 'parent' });
  await act(async () => root.render(
    <I18nProvider>
      <HeaderSessionArchiveMenuItem sessionId="target" Item={Item} onArchive={() => { archiveRequests += 1; }} />
    </I18nProvider>,
  ));
  expect(document.querySelector('button')?.textContent).toBe('Restore');
});
