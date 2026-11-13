import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openNativeSessionLink } from './openNativeSessionLink';
import { peekMessageFocus, settleMessageFocus } from './messageFocus';
import type { BotsRouteTarget } from './types';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalProjects = useProjectsStore.getState();
const originalSessions = useGlobalSessionsStore.getState();
const originalSessionUI = useSessionUIStore.getState();
const botTarget = { projectId: 'project-one', itemId: 'item-one' };
type HostSessionRequest = { readonly runtimeKey: string; readonly sessionId: string | null; readonly botTarget?: BotsRouteTarget };
const calls: Array<{ command: string; args: HostSessionRequest }> = [];
let dom: Window;

beforeEach(() => {
  dom = new Window({ url: 'http://native-notification.test' });
  Object.defineProperties(dom, {
    __OPENCHAMBER_API_BASE_URL__: { value: 'http://native-notification.test' },
    __OPENCHAMBER_LOCAL_ORIGIN__: { value: 'http://native-notification.test' },
    __OPENCHAMBER_ELECTRON__: { value: { runtime: 'electron' } },
    __OPENCHAMBER_DESKTOP__: { configurable: true, value: { invoke: async (command: string, args: HostSessionRequest) => {
      calls.push({ command, args });
      return { opened: false };
    } } },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
  calls.length = 0;
  useUIStore.setState({ isBotsPageOpen: false, botsPageTarget: null, isSettingsDialogOpen: false });
  // Selection now requires an admitted directory, as in openSessionFromRoute's fixtures.
  useProjectsStore.setState({ projects: ['/current', '/ordinary', '/linked', '/stage', '/fallback'].map((path) => ({ id: path, path })) });
  useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [], entityById: new Map(), hasLoaded: true, status: 'ready' });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, availableWorktreesByProject: new Map() });
  useSessionUIStore.getState().setCurrentSession('ses_current', '/current');
});

afterEach(async () => {
  const focus = peekMessageFocus('ses_link');
  if (focus) settleMessageFocus(focus);
  useUIStore.setState({ isBotsPageOpen: false, botsPageTarget: null });
  useProjectsStore.setState(originalProjects, true);
  useGlobalSessionsStore.setState(originalSessions, true);
  useSessionUIStore.setState(originalSessionUI, true);
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  await dom.happyDOM.close();
});

for (const sessionId of [undefined, 'ses_stage']) {
  test(`opens the exact Bots item without selecting its stage session (${sessionId})`, async () => {
    useUIStore.setState({ isSettingsDialogOpen: true });

    await openNativeSessionLink(new CustomEvent('openchamber:open-session', { detail: { botTarget, sessionId, directory: '/stage', runtimeKey: 'local' } }));

    expect(useUIStore.getState().botsPageTarget).toEqual(botTarget);
    expect(useUIStore.getState().isBotsPageOpen).toBe(true);
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_current');
  });

  test(`delegates a foreign item to its owning runtime without applying it locally (${sessionId})`, async () => {
    await openNativeSessionLink(new CustomEvent('openchamber:open-session', { detail: { botTarget, sessionId, runtimeKey: 'host:owner' } }));

    expect(calls).toEqual([{ command: 'desktop_open_host_session', args: { runtimeKey: 'host:owner', sessionId: sessionId ?? null, botTarget } }]);
    expect(useUIStore.getState().botsPageTarget).toBeNull();
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_current');
  });
}

test('leaves a foreign item unapplied when no desktop bridge is available', async () => {
  Reflect.deleteProperty(dom, '__OPENCHAMBER_DESKTOP__');

  await openNativeSessionLink(new CustomEvent('openchamber:open-session', { detail: { botTarget, runtimeKey: 'host:missing' } }));

  expect(useUIStore.getState().isBotsPageOpen).toBe(false);
  expect(useUIStore.getState().botsPageTarget).toBeNull();
});

for (const target of [null, {}, { projectId: 'p', itemId: '../i' }, { projectId: 'p', itemId: 'i', url: 'https://other.test' }]) {
  test(`rejects malformed item navigation without falling back to its session: ${JSON.stringify(target)}`, async () => {
    await openNativeSessionLink(new CustomEvent('openchamber:open-session', { detail: { botTarget: target, sessionId: 'ses_fallback', directory: '/fallback' } }));

    expect(useUIStore.getState().botsPageTarget).toBeNull();
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_current');
    expect(calls).toEqual([]);
  });
}

test('keeps ordinary native session selection with an explicit directory', async () => {
  await openNativeSessionLink(new CustomEvent('openchamber:open-session', { detail: { sessionId: 'ses_ordinary', directory: '/ordinary', guestId: null, runtimeKey: 'local' } }));

  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_ordinary');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/ordinary');
  expect(useUIStore.getState().isBotsPageOpen).toBe(false);
});

test('resolves ordinary message links through the session route', async () => {
  useGlobalSessionsStore.setState({
    activeSessions: [{
      id: 'ses_link', projectID: 'project-one', title: 'Linked session', directory: '/linked',
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    }],
    archivedSessions: [], hasLoaded: true, status: 'ready',
  });

  await openNativeSessionLink(new CustomEvent('openchamber:open-session', { detail: { sessionId: 'ses_link', messageId: 'msg_link' } }));

  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/linked');
  expect(peekMessageFocus('ses_link')?.messageId).toBe('msg_link');
});

test('keeps ordinary foreign sessions on the owning runtime', async () => {
  await openNativeSessionLink(new CustomEvent('openchamber:open-session', { detail: { sessionId: 'ses_foreign', runtimeKey: 'host:owner' } }));

  expect(calls).toEqual([{ command: 'desktop_open_host_session', args: { runtimeKey: 'host:owner', sessionId: 'ses_foreign' } }]);
  expect(useSessionUIStore.getState().currentSessionId).toBe('ses_current');
});
