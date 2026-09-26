import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { SessionInfo } from '@opencode/client';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey, MOBILE_DISCONNECTED_RUNTIME_KEY, switchRuntimeEndpoint, UNINITIALIZED_RUNTIME_KEY } from '@/lib/runtime-switch';
import {
  sessionHistory, startSessionHistoryTracking, resolveSessionHistoryDestination,
  navigateSessionHistory, pauseSessionHistory, resumeSessionHistory,
} from './sessionNavigationHistory';

// SAFETY: the UI type-check does not include bun's global types; this declares
// only the local HTTP fixture this test uses.
declare const Bun: {
  serve: (options: { port: number; fetch: (request: Request) => Response }) => {
    url: URL;
    stop: (force?: boolean) => void;
  };
};

const value = (id: string): Session => ({
  id, projectID: 'p', directory: '/project', title: id,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

test('seeds an existing selection and records normal store selection changes', () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  let stop = () => {};
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(browser, '__OPENCHAMBER_API_BASE_URL__', { value: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  try {
    useGlobalSessionsStore.setState({ entityById: new Map([['A', value('A')], ['B', value('B')]]) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    sessionHistory.setScope('adapter-fixture');
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    const before = sessionHistory.getSnapshot();
    useGlobalSessionsStore.getState().upsertSession({ ...value('B'), title: 'renamed' });
    expect(sessionHistory.getSnapshot()).toBe(before);
  } finally {
    stop();
    sessionHistory.setScope('adapter-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('lookup distinguishes unloaded, archived, authoritative missing and uncertain failure', async () => {
  let status = 200;
  const { directory, ...session } = value('unloaded');
  const info: SessionInfo = { ...session, location: { directory } };
  let body: SessionInfo | { _tag: string; message: string } = info;
  let beforeResponse = () => {};
  let requestedDirectory: string | null = null;
  const server = Bun.serve({ port: 0, fetch: (request) => {
    requestedDirectory = request.headers.get('x-opencode-directory');
    beforeResponse();
    return Response.json(status === 200 ? { data: body } : body, { status });
  } });
  const previousResolver = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: server.url.toString() });
  opencodeClient.reconnectToRuntimeBaseUrl();
  const signal = new AbortController().signal;
  const entry = { sessionId: 'unloaded', directory: '/project' };
  const global = useGlobalSessionsStore.getState();
  try {
    useGlobalSessionsStore.setState({ entityById: new Map() });
    expect(await resolveSessionHistoryDestination(entry, signal)).toEqual(value('unloaded'));
    expect(requestedDirectory).toBe(encodeURIComponent(entry.directory));
    const canceled = new AbortController();
    beforeResponse = () => canceled.abort();
    await expect(resolveSessionHistoryDestination(entry, canceled.signal)).rejects.toThrow();
    beforeResponse = () => {};
    body = { ...info, time: { created: 1, updated: 1, archived: 2 } };
    expect(await resolveSessionHistoryDestination(entry, signal)).toBeNull();
    status = 404;
    body = { _tag: 'SessionNotFoundError', message: 'Session not found' };
    expect(await resolveSessionHistoryDestination(entry, signal)).toBeNull();
    await expect(resolveSessionHistoryDestination({ ...entry, directory: null }, signal)).rejects.toThrow();
    status = 503;
    await expect(resolveSessionHistoryDestination(entry, signal)).rejects.toThrow();
    status = 403;
    await expect(resolveSessionHistoryDestination(entry, signal)).rejects.toThrow();
    status = 404;
    body = { _tag: 'ProxyError', message: 'upstream unavailable' };
    await expect(resolveSessionHistoryDestination(entry, signal)).rejects.toThrow();
    status = 200;
    body = info;
    beforeResponse = () => { useGlobalSessionsStore.getState().removeSessions(['unloaded']); };
    expect(await resolveSessionHistoryDestination(entry, signal)).toBeNull();
    beforeResponse = () => {
      useGlobalSessionsStore.getState().upsertSession({
        ...value('unloaded'), time: { created: 1, updated: 3, archived: 3 },
      });
    };
    expect(await resolveSessionHistoryDestination(entry, signal)).toBeNull();
  } finally {
    server.stop(true);
    setRuntimeUrlResolver(previousResolver);
    opencodeClient.reconnectToRuntimeBaseUrl();
    useGlobalSessionsStore.setState(global, true);
  }
});

// Browser and VS Code bootstrap tests precede `switchRuntimeEndpoint`, which
// pins the runtime key for the rest of this isolated test process.
test('an ordinary browser window without injected endpoint globals records and navigates visits', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    expect(Object.getOwnPropertyDescriptor(browser, '__OPENCHAMBER_API_BASE_URL__')?.value ?? null).toBeNull();
    useGlobalSessionsStore.setState({ entityById: new Map([['A', value('A')], ['B', value('B')]]) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(navigateSessionHistory(-1)).toBe(true);
    await Promise.resolve();
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    expect(sessionHistory.getSnapshot().canGoForward).toBe(true);
  } finally {
    stop();
    sessionHistory.setScope('web-scope-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('desktop vscode bootstrap navigates and reconsiders visits when the workspace changes', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const projects = useProjectsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'vscode-webview://history-test/index.html' });
  Object.defineProperty(browser, '__VSCODE_CONFIG__', { value: { workspaceFolder: '/ws', workspaceFolders: [{ name: 'ws', path: '/ws' }], theme: 'dark', connectionStatus: 'connected' } });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  const inWorkspace = (id: string, directory: string): Session => ({
    ...value(id), directory,
  });
  let stop = () => {};
  try {
    expect(getRuntimeKey()).toBe(UNINITIALIZED_RUNTIME_KEY);
    expect(Object.getOwnPropertyDescriptor(browser, '__OPENCHAMBER_API_BASE_URL__')).toBe(undefined);
    useProjectsStore.setState({ projects: [{ id: 'p1', path: '/ws' }], activeProjectId: 'p1' });
    useGlobalSessionsStore.setState({ entityById: new Map([
      ['A', inWorkspace('A', '/ws')],
      ['B', inWorkspace('B', '/other')],
      ['C', inWorkspace('C', '/ws/worktree')],
    ]) });
    useSessionUIStore.setState({ currentSessionId: 'B', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'A' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(navigateSessionHistory(-1)).toBe(true);
    await Promise.resolve();
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);

    useProjectsStore.setState({ projects: [{ id: 'p2', path: '/other' }], activeProjectId: 'p2' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(await sessionHistory.navigate(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('B');
    useProjectsStore.setState({ projects: [{ id: 'p1', path: '/ws' }], activeProjectId: 'p1' });
    expect(await sessionHistory.navigate(1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');

    useSessionUIStore.setState({ currentSessionId: 'C' });
    expect(navigateSessionHistory(-1)).toBe(true);
    await Promise.resolve();
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
    expect(await sessionHistory.navigate(1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('C');
  } finally {
    stop();
    sessionHistory.setScope('adapter-vscode-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    useProjectsStore.setState(projects, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('VS Code history follows worktree ownership and recovers after discovery', async () => {
  const projects = useProjectsStore.getState();
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'vscode-webview://history-test/index.html' });
  Object.defineProperty(browser, '__VSCODE_CONFIG__', { value: { workspaceFolder: '/ws' } });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    useProjectsStore.setState({ projects: [{ id: 'p1', path: '/ws' }, { id: 'p2', path: '/other' }], activeProjectId: 'p1' });
    const worktree = { ...value('W'), directory: '/external/worktree' };
    useGlobalSessionsStore.setState({ entityById: new Map([
      ['A', { ...value('A'), directory: '/ws' }], ['W', worktree],
      ['other', { ...value('other'), directory: '/other/subdir' }],
      ['lookalike', { ...value('lookalike'), directory: '/ws-other' }],
    ]) });
    useSessionUIStore.setState({ currentSessionId: 'W', availableWorktreesByProject: new Map(), newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'A' });
    expect(await sessionHistory.navigate(-1)).toBe(false);
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([
      ['/ws', [{ path: worktree.directory, projectDirectory: '/ws', branch: 'feature', label: 'feature' }]],
    ]) });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    const signal = new AbortController().signal;
    expect(await resolveSessionHistoryDestination({ sessionId: 'W', directory: worktree.directory }, signal)).toBe(worktree);
    for (const sessionId of ['other', 'lookalike']) {
      expect(await resolveSessionHistoryDestination({ sessionId, directory: null }, signal)).toBeNull();
    }
  } finally {
    stop();
    sessionHistory.setScope('worktree-ownership-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    useProjectsStore.setState(projects, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('mobile disconnect stays suspended and a server switch resets the browser scope', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    useGlobalSessionsStore.setState({ entityById: new Map([['A', value('A')], ['B', value('B')]]) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);

    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'A' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);

    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:5001', runtimeKey: 'url:http://localhost:5001' });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'A' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
  } finally {
    stop();
    sessionHistory.setScope('web-scope-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('runtime scope lifecycle preserves, suspends and reseeds visits', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(browser, '__OPENCHAMBER_API_BASE_URL__', { value: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    useGlobalSessionsStore.setState({ entityById: new Map([['A', value('A')], ['B', value('B')]]) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:4599', runtimeKey: 'url:http://localhost:4599' });
    resumeSessionHistory();
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);

    pauseSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);

    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:4599', runtimeKey: 'url:http://localhost:4599' });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);

    pauseSessionHistory();
    useSessionUIStore.setState({ currentSessionId: 'A' });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:5000', runtimeKey: 'url:http://localhost:5000' });
    resumeSessionHistory();
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    useSessionUIStore.setState({ currentSessionId: 'B' });
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(navigateSessionHistory(-1)).toBe(true);
    await Promise.resolve();
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
  } finally {
    stop();
    sessionHistory.setScope('adapter-scope-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('restored visits become navigable again without selecting them first', async () => {
  const ui = useSessionUIStore.getState();
  const global = useGlobalSessionsStore.getState();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new Window({ url: 'http://localhost:4599' });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  let stop = () => {};
  try {
    useGlobalSessionsStore.setState({ entityById: new Map(['A', 'B', 'C'].map((id) => [id, value(id)])) });
    useSessionUIStore.setState({ currentSessionId: 'A', newSessionDraft: { ...ui.newSessionDraft, open: false } });
    stop = startSessionHistoryTracking();
    useSessionUIStore.setState({ currentSessionId: 'B' });
    useSessionUIStore.setState({ currentSessionId: 'C' });
    const archive = (id: string) => useGlobalSessionsStore.getState().upsertSession({
      ...value(id), time: { created: 1, updated: 2, archived: 2 },
    });
    const restore = (id: string) => useGlobalSessionsStore.getState().upsertSession({
      ...value(id), time: { created: 1, updated: 3, archived: 0 },
    });
    archive('B');
    expect(await sessionHistory.navigate(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');
    restore('B');
    expect(await sessionHistory.navigate(1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('B');

    // A disabled direction also recovers from an authoritative unarchive.
    archive('A');
    expect(await sessionHistory.navigate(-1)).toBe(false);
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    const before = sessionHistory.getSnapshot();
    for (let i = 0; i < 100; i += 1) {
      useGlobalSessionsStore.getState().upsertSession({ ...value('C'), title: `C ${i}` });
    }
    expect(sessionHistory.getSnapshot()).toBe(before);
    restore('A');
    expect(sessionHistory.getSnapshot().canGoBack).toBe(true);
    expect(await sessionHistory.navigate(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('A');

    archive('B');
    expect(await sessionHistory.navigate(1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('C');
    pauseSessionHistory();
    restore('B');
    expect(sessionHistory.getSnapshot().canGoBack).toBe(false);
    resumeSessionHistory();
    expect(await sessionHistory.navigate(-1)).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('B');
  } finally {
    stop();
    sessionHistory.setScope('restore-cleanup');
    useSessionUIStore.setState(ui, true);
    useGlobalSessionsStore.setState(global, true);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
