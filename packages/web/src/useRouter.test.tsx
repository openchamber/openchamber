// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest';
import { useRouter } from '@openchamber/ui/hooks/useRouter';
import { navigateFromNotification } from '@openchamber/ui/lib/router/notificationNavigation';
import { useSessionUIStore } from '@openchamber/ui/sync/session-ui-store';
import * as globalSessions from '@openchamber/ui/stores/useGlobalSessionsStore';
import { useUIStore } from '@openchamber/ui/stores/useUIStore';
import { useDirectoryStore } from '@openchamber/ui/stores/useDirectoryStore';
import type { Session } from '@openchamber/ui/lib/opencode/model';

vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));
});

type SessionsSnapshot = Awaited<ReturnType<typeof globalSessions.ensureGlobalSessionsLoaded>>;
let loadSessions: MockInstance<typeof globalSessions.ensureGlobalSessionsLoaded>;

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
  useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'home' });
  useDirectoryStore.setState({ currentDirectory: '/project' });
  globalSessions.useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [], entityById: new Map() });
  vi.spyOn(useSessionUIStore.getState(), 'getDirectoryForSession').mockReturnValue('/project');
  vi.spyOn(useSessionUIStore.getState(), 'setCurrentSession').mockImplementation((id, directory) => {
    useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: directory });
  });
  loadSessions = vi.spyOn(globalSessions, 'ensureGlobalSessionsLoaded')
    .mockResolvedValue({ activeSessions: [], archivedSessions: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllGlobals());

test('notification navigation opens B through the session-link owner and keeps the document mounted', async () => {
  await act(async () => root.render(<Router />));
  const mounted = host.firstChild;
  const documentBefore = window.document;
  const assign = vi.spyOn(window.location, 'assign');
  const pushState = vi.spyOn(window.history, 'pushState');
  let finishLoad!: (snapshot: SessionsSnapshot) => void;
  loadSessions.mockImplementationOnce(() => {
    expect(window.location.search).toBe('?session=ses_B');
    return new Promise<SessionsSnapshot>((resolve) => { finishLoad = resolve; });
  });

  expect(navigateFromNotification('/?session=ses_B')).toBe(true);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_B');
  expect(pushState).toHaveBeenCalledOnce();
  expect(navigateFromNotification('/?session=ses_C')).toBe(false);
  expect(window.location.search).toBe('?session=ses_B');

  await act(async () => finishLoad({
    activeSessions: [{
      id: 'ses_B', directory: '/other-project', title: 'B', projectID: 'project',
      time: { created: 1, updated: 1 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } satisfies Session], archivedSessions: [],
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
  loadSessions.mockImplementationOnce(() => new Promise<SessionsSnapshot>((resolve) => {
    finishLoad = () => resolve({ activeSessions: [], archivedSessions: [] });
  }));
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
  vi.spyOn(useSessionUIStore.getState(), 'setCurrentSession')
    .mockImplementationOnce(() => { throw new Error('selection failed'); });
  expect(navigateFromNotification('/?session=ses_B')).toBe(true);
  await act(async () => {});
  expect(log).toHaveBeenCalledWith('[PWA] notification navigation failed:', expect.any(Error));
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_A');
  expect(navigateFromNotification('/?session=ses_C')).toBe(true);
  await act(async () => {});
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_C');
});
