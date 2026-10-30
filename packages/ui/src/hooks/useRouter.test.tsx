import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { openSession } from '@/lib/router/openSessionFromRoute';
import { navigateFromNotification } from '@/lib/router/notificationNavigation';
import { applyVSCodeSessionNavigation, vscodeSessionNavigationSchema } from '@/apps/vscodeSessionNavigation';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useBtwStore } from '@/stores/useBtwStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRouter } from './useRouter';

const session = (id: string): Session => ({
  id, projectID: 'project', directory: '/project', title: id,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
});
const parent = session('parent');
const fork: Session = {
  ...session('fork'), parentID: parent.id,
  metadata: { openchamber: { kind: 'btw', originalSessionID: parent.id } },
};
let dom: Window;
let root: Root;
let entries: string[];
let restoreHistory: () => void;
let replaceURL: (url: string) => void;
const originals = new Map<string, PropertyDescriptor | undefined>();
const Harness = () => { useRouter(); return null; };

beforeEach(() => {
  dom = new Window({ url: 'http://localhost/?session=previous' });
  for (const [key, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  useSessionUIStore.getState().setCurrentSession('previous', '/project');
  useUIStore.setState({ isSettingsDialogOpen: false });
  useGlobalSessionsStore.setState({
    activeSessions: [session('previous'), parent, fork], archivedSessions: [],
    entityById: new Map(), hasLoaded: true, status: 'ready',
  });
  useBtwStore.setState({ byParent: {} });
  // Happy DOM reloads documents on Back instead of emitting same-document popstate.
  // Keep native URL writes and model only the history traversal for this test.
  entries = [window.location.href];
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  const pushSpy = spyOn(window.history, 'pushState').mockImplementation((state, unused, url) => {
    push(state, unused, url);
    entries.push(window.location.href);
  });
  const replaceSpy = spyOn(window.history, 'replaceState').mockImplementation((state, unused, url) => {
    replace(state, unused, url);
    entries[entries.length - 1] = window.location.href;
  });
  replaceURL = (url) => replace({}, '', url);
  restoreHistory = () => { pushSpy.mockRestore(); replaceSpy.mockRestore(); };
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreHistory();
  await dom.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

const back = async () => {
  await act(async () => {
    entries.pop();
    replaceURL(entries[entries.length - 1]);
    window.dispatchEvent(new window.PopStateEvent('popstate'));
  });
};

test('a cold notification open replaces the fork entry and one Back returns to the previous chat', async () => {
  await act(async () => root.render(<Harness />));
  const length = entries.length;
  await act(async () => openSession('fork', { directory: '/project' }));
  expect(useSessionUIStore.getState().currentSessionId).toBe('parent');
  expect(window.location.search).toBe('?session=parent');
  expect(entries.length).toBe(length + 1);
  await back();
  expect(useSessionUIStore.getState().currentSessionId).toBe('previous');
  expect(window.location.search).toBe('?session=previous');
  // A store update after popstate must still create a fresh navigation entry.
  await act(async () => openSession('parent'));
  expect(window.location.search).toBe('?session=parent');
});

test('Back to an old fork URL normalizes it to the selected parent', async () => {
  window.history.replaceState({}, '', '/?session=fork');
  window.history.pushState({}, '', '/?session=previous');
  await act(async () => root.render(<Harness />));
  await back();
  expect(useSessionUIStore.getState().currentSessionId).toBe('parent');
  expect(window.location.search).toBe('?session=parent');
  expect(useBtwStore.getState().byParent.parent?.collapsed).toBe(false);
});

test('repeated Back to a fork message link preserves its transcript and message target', async () => {
  window.history.replaceState({}, '', '/?session=fork&message=msg');
  window.history.pushState({}, '', '/?session=previous');
  await act(async () => root.render(<Harness />));

  for (let visit = 0; visit < 2; visit++) {
    await back();
    expect(useSessionUIStore.getState().currentSessionId).toBe('fork');
    expect(window.location.search).toBe('?session=fork&message=msg');
    expect(useBtwStore.getState().byParent.parent).toBeUndefined();
    await act(async () => openSession('previous'));
  }
});

test('initial fork message links retain their message target', async () => {
  window.history.replaceState({}, '', '/?session=fork&message=msg');
  await act(async () => root.render(<Harness />));
  expect(useSessionUIStore.getState().currentSessionId).toBe('fork');
  expect(window.location.search).toBe('?session=fork&message=msg');
});

test('a PWA notification normalizes the fork URL and preserves one-step Back', async () => {
  await act(async () => root.render(<Harness />));
  const length = entries.length;
  await act(async () => {
    expect(navigateFromNotification('http://localhost/?session=fork')).toBe(true);
  });
  expect(useSessionUIStore.getState().currentSessionId).toBe('parent');
  expect(window.location.search).toBe('?session=parent');
  expect(entries.length).toBe(length + 1);
  expect(useBtwStore.getState().byParent.parent?.collapsed).toBe(false);
  await back();
  expect(useSessionUIStore.getState().currentSessionId).toBe('previous');
  expect(window.location.search).toBe('?session=previous');
});

for (const source of ['initial route', 'PWA notification']) {
  test(`Back during a cold ${source} preserves the previous chat`, async () => {
    if (source === 'PWA notification') {
      await act(async () => root.render(<Harness />));
    } else {
      window.history.pushState({}, '', '/?session=fork');
    }
    const snapshot = { activeSessions: [session('previous'), parent, fork], archivedSessions: [] };
    let resolveLoading!: (value: typeof snapshot) => void;
    const loading = new Promise<typeof snapshot>((resolve) => { resolveLoading = resolve; });
    const load = spyOn(useGlobalSessionsStore.getState(), 'loadSessions').mockImplementation(() => loading);
    useGlobalSessionsStore.setState({ activeSessions: [], entityById: new Map(), hasLoaded: false, status: 'loading' });
    try {
      await act(async () => {
        if (source === 'PWA notification') {
          expect(navigateFromNotification('http://localhost/?session=fork')).toBe(true);
        } else {
          root.render(<Harness />);
        }
      });
      expect(useSessionUIStore.getState().currentSessionId).toBe('fork');
      await back();
      expect(window.location.search).toBe('?session=previous');
      await act(async () => {
        useGlobalSessionsStore.setState({ ...snapshot, hasLoaded: true, status: 'ready' });
        resolveLoading(snapshot);
        await loading;
      });
      expect(useSessionUIStore.getState().currentSessionId).toBe('previous');
      expect(window.location.search).toBe('?session=previous');
      expect(entries).toEqual(['http://localhost/?session=previous']);
    } finally {
      resolveLoading(snapshot);
      load.mockRestore();
    }
  });
}

test('the VS Code notification command selects the parent, expands its panel and opens chat', async () => {
  let view: unknown;
  window.addEventListener('openchamber:navigate', (event) => { view = (event as CustomEvent).detail; });
  useBtwStore.getState().setPanelState('parent', { collapsed: true });
  applyVSCodeSessionNavigation(vscodeSessionNavigationSchema.parse({ sessionId: ' fork ' }));
  await Promise.resolve();
  await Promise.resolve();
  expect(useSessionUIStore.getState().currentSessionId).toBe('parent');
  expect(useBtwStore.getState().byParent.parent?.collapsed).toBe(false);
  expect(view).toEqual({ view: 'chat' });
  expect(vscodeSessionNavigationSchema.safeParse({ sessionId: ' ' }).success).toBe(false);
  expect(vscodeSessionNavigationSchema.safeParse(null).success).toBe(false);
  expect(vscodeSessionNavigationSchema.safeParse({ sessionId: 42 }).success).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBe('parent');
});
