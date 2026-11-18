import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useEffect } from 'react';
import type { Root } from 'react-dom/client';
import { installSuggestedTasksDom, serveSuggestedTasks } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const requests: string[] = [];
const server = await serveSuggestedTasks((request) => {
  requests.push(new URL(request.url).pathname);
  return Response.json({});
});
const { createRoot } = await import('react-dom/client');
const { useRouter } = await import('./useRouter');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { hasRouteParams } = await import('@/lib/router/parseRoute');
const { subscribeMainSurfaceNavigation } = await import('@/lib/router/subscribeMainSurfaceNavigation');
let root: Root;

function Harness({ openMobileBots }: { readonly openMobileBots?: () => void }) {
  useEffect(subscribeMainSurfaceNavigation, []);
  useRouter(openMobileBots);
  return null;
}

beforeEach(() => {
  Reflect.deleteProperty(window, '__VSCODE_CONFIG__');
  window.__OPENCHAMBER_SURFACE__ = 'desktop';
  switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'router-a' });
  useUIStore.getState().closeMainSurfaces();
  useUIStore.getState().setSettingsDialogOpen(false);
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: useSessionUIStore.getInitialState().newSessionDraft });
  window.history.replaceState({}, '', '/');
  requests.length = 0;
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, '__VSCODE_CONFIG__');
  useUIStore.getState().closeMainSurfaces();
});
afterAll(async () => { await server.stop(true); await dom.restore(); });

describe('Bots query route application', () => {
  test('keeps the initial item open when background preparation updates the same draft', async () => {
    // Given a startup draft behind an already applied, consumed item link.
    const draft = { ...useSessionUIStore.getState().newSessionDraft, open: true, draftId: 7 };
    useSessionUIStore.setState({ newSessionDraft: draft });
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');
    await act(async () => root.render(<Harness />));

    // When preparation publishes its directory without changing draft identity.
    await act(async () => useSessionUIStore.setState({
      newSessionDraft: { ...draft, preparedChatDirectory: '/home/test/chats/prepared' },
    }));

    // Then the requested item remains open after bootstrap and URL consumption.
    expect(useUIStore.getState().isBotsPageOpen).toBe(true);
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-2', itemId: 'item-7' });
    expect(window.location.search).toBe('');
  });

  test('closes the item when navigation opens another draft while a draft is already open', async () => {
    // Given Bots over a startup draft.
    const draft = { ...useSessionUIStore.getState().newSessionDraft, open: true, draftId: 7 };
    useSessionUIStore.setState({ newSessionDraft: draft });
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');
    await act(async () => root.render(<Harness />));

    // When navigation opens a different draft.
    await act(async () => useSessionUIStore.setState({ newSessionDraft: { ...draft, draftId: 8 } }));

    // Then the previous one-shot destination is retired.
    expect(useUIStore.getState().isBotsPageOpen).toBe(false);
    expect(useUIStore.getState().botsPageTarget).toBeNull();
  });

  test('closes the item when navigation selects a session', async () => {
    // Given an open item destination.
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');
    await act(async () => root.render(<Harness />));

    // When navigation selects a session.
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'ses_selected' }));

    // Then the selected session replaces Bots.
    expect(useUIStore.getState().isBotsPageOpen).toBe(false);
    expect(useUIStore.getState().botsPageTarget).toBeNull();
  });

  test('opens the initial item target when there is no session', async () => {
    // Given a push URL and another open main page.
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');
    useUIStore.getState().setScheduledTasksDialogOpen(true);
    expect(hasRouteParams()).toBe(true);

    // When the shared router mounts.
    await act(async () => root.render(<Harness />));

    // Then Bots opens the exact target without starting a session lookup.
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-2', itemId: 'item-7' });
    expect(useUIStore.getState().isBotsPageOpen).toBe(true);
    expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(requests.filter((path) => path.includes('/session'))).toEqual([]);
    expect(window.location.search).toBe('');
  });

  test('opens an item from popstate when the router was already mounted', async () => {
    // Given an initialized router with no route parameters.
    await act(async () => root.render(<Harness />));
    window.history.pushState({}, '', '/?botsProject=project-3&botItem=item-8');

    // When a browser history navigation reaches the item URL.
    await act(async () => window.dispatchEvent(new Event('popstate')));

    // Then the named project and item become the one-shot destination.
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-3', itemId: 'item-8' });
    expect(useUIStore.getState().isBotsPageOpen).toBe(true);
  });

  test('uses the mobile shell opener when applying the item URL', async () => {
    // Given a mobile surface with its own main navigation action.
    window.__OPENCHAMBER_SURFACE__ = 'mobile';
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');
    let mobileOpens = 0;

    // When its router applies the URL.
    await act(async () => root.render(<Harness openMobileBots={() => { mobileOpens += 1; }} />));

    // Then the mobile action opens once and the desktop page stays closed.
    expect(mobileOpens).toBe(1);
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-2', itemId: 'item-7' });
    expect(useUIStore.getState().isBotsPageOpen).toBe(false);
  });

  test('does not fall through to desktop when a mobile shell opener is absent', async () => {
    // Given mobile routing without a mounted shell action.
    window.__OPENCHAMBER_SURFACE__ = 'mobile';
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');

    // When a target is applied.
    await act(async () => root.render(<Harness />));

    // Then no unsupported desktop navigation or orphan target is installed.
    expect(useUIStore.getState().isBotsPageOpen).toBe(false);
    expect(useUIStore.getState().botsPageTarget).toBeNull();
  });

  test('prioritizes an item over conflicting session and settings parameters', async () => {
    // Given a target URL that also names an unrelated session and settings page.
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7&session=ses_other&settings=providers');

    // When the route is applied.
    await act(async () => root.render(<Harness />));

    // Then the item opens immediately without a session or Settings overlay.
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-2', itemId: 'item-7' });
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
  });

  test('leaves Bots absent when a direct link arrives in VS Code', async () => {
    // Given a VS Code webview and an otherwise valid Bots target.
    Object.defineProperty(window, '__VSCODE_CONFIG__', { value: {}, configurable: true });
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');

    // When its state-only router mounts.
    await act(async () => root.render(<Harness />));

    // Then no Bots page, target or API request falls through to another runtime.
    expect(useUIStore.getState().isBotsPageOpen).toBe(false);
    expect(useUIStore.getState().botsPageTarget).toBeNull();
    expect(requests.filter((path) => path.includes('/bots'))).toEqual([]);
  });

  test('retires an unconsumed target when the runtime changes', async () => {
    // Given a target whose project has not consumed it yet.
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');
    await act(async () => root.render(<Harness />));

    // When switching away and back, including an equal-ID destination on the new server.
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'router-b' });
      switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'router-a' });
    });

    // Then the old request cannot reopen or target the new visit.
    expect(useUIStore.getState().botsPageTarget).toBeNull();
    expect(useUIStore.getState().isBotsPageOpen).toBe(false);
  });

  test('keeps the target when only credentials refresh on the same runtime', async () => {
    // Given an item target waiting for its project.
    window.history.replaceState({}, '', '/?botsProject=project-2&botItem=item-7');
    await act(async () => root.render(<Harness />));

    // When endpoint credentials refresh without changing runtime identity.
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'router-a' }));

    // Then the still-owned target stays available to its project.
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-2', itemId: 'item-7' });
  });
});
