// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useRouter } from '@openchamber/ui/hooks/useRouter';
import { navigateFromNotification } from '@openchamber/ui/lib/router/notificationNavigation';
import { useSessionUIStore } from '@openchamber/ui/sync/session-ui-store';

const { loadSessions } = vi.hoisted(() => ({ loadSessions: vi.fn() }));

vi.mock('@openchamber/ui/stores/useGlobalSessionsStore', () => ({
  ensureGlobalSessionsLoaded: loadSessions,
  resolveGlobalSessionDirectory: (session: { directory: string }) => session.directory,
}));
vi.mock('@openchamber/ui/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return {
    useSessionUIStore: create((set) => ({
      currentSessionId: 'ses_A',
      currentSessionDirectory: '/project',
      getDirectoryForSession: () => '/project',
      setCurrentSession: (id: string, directory: string) => set({
        currentSessionId: id, currentSessionDirectory: directory,
      }),
    })),
  };
});
vi.mock('@openchamber/ui/stores/useUIStore', async () => {
  const { create } = await import('zustand');
  return {
    useUIStore: create((set) => ({
      isSettingsDialogOpen: false,
      settingsPage: 'home',
      setSettingsDialogOpen: (open: boolean) => set({ isSettingsDialogOpen: open }),
      setSettingsPage: (page: string) => set({ settingsPage: page }),
      navigateToDiff: vi.fn(),
    })),
  };
});
vi.mock('@openchamber/ui/stores/useDirectoryStore', () => ({
  useDirectoryStore: { getState: () => ({ currentDirectory: '/project' }) },
}));
vi.mock('@openchamber/ui/lib/settings/metadata', () => ({ resolveSettingsSlug: (slug: string) => slug }));

let root: Root;
let host: HTMLDivElement;

function Router() {
  useRouter();
  return <div>Mounted app</div>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', '/?session=ses_A');
  useSessionUIStore.setState({ currentSessionId: 'ses_A', currentSessionDirectory: '/project' });
  loadSessions.mockReset().mockResolvedValue({ activeSessions: [], archivedSessions: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('notification navigation opens B through the session-link owner and keeps the document mounted', async () => {
  await act(async () => root.render(<Router />));
  const mounted = host.firstChild;
  const documentBefore = window.document;
  const assign = vi.spyOn(window.location, 'assign');
  const pushState = vi.spyOn(window.history, 'pushState');
  let finishLoad!: (snapshot: unknown) => void;
  loadSessions.mockImplementationOnce(() => {
    expect(window.location.search).toBe('?session=ses_B');
    return new Promise((resolve) => { finishLoad = resolve; });
  });

  expect(navigateFromNotification('/?session=ses_B')).toBe(true);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_B');
  expect(pushState).toHaveBeenCalledOnce();
  expect(navigateFromNotification('/?session=ses_C')).toBe(false);
  expect(window.location.search).toBe('?session=ses_B');

  await act(async () => finishLoad({
    activeSessions: [{ id: 'ses_B', directory: '/other-project' }], archivedSessions: [],
  }));
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/other-project');
  expect(window.document).toBe(documentBefore);
  expect(host.firstChild).toBe(mounted);
  expect(assign).not.toHaveBeenCalled();

  await act(async () => root.render(null));
  expect(navigateFromNotification('/?session=ses_C')).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_B');
  expect(pushState).toHaveBeenCalledOnce();
});

test('startup declines notification navigation until the initial route finishes', async () => {
  let finishLoad!: () => void;
  loadSessions.mockImplementationOnce(() => new Promise<void>((resolve) => { finishLoad = resolve; }));
  await act(async () => root.render(<Router />));
  expect(navigateFromNotification('/?session=ses_B')).toBe(false);
  expect(window.location.search).toBe('?session=ses_A');
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_A');
  await act(async () => finishLoad());
  expect(navigateFromNotification('/?session=ses_B')).toBe(true);
  await act(async () => {});
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_B');
});

test('an accepted route failure releases the busy guard for the next click', async () => {
  await act(async () => root.render(<Router />));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const select = vi.spyOn(useSessionUIStore.getState(), 'setCurrentSession')
    .mockImplementationOnce(() => { throw new Error('selection failed'); });
  expect(navigateFromNotification('/?session=ses_B')).toBe(true);
  await act(async () => {});
  expect(log).toHaveBeenCalledWith('[PWA] notification navigation failed:', expect.any(Error));
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_A');
  select.mockRestore();
  expect(navigateFromNotification('/?session=ses_C')).toBe(true);
  await act(async () => {});
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_C');
});
