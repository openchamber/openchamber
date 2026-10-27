import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { useTraySync } from './useTraySync';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { getPinnedSessionKey } from '@/lib/sessionPins';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import {
  applyGlobalBlockingRequestEvents,
  applyWaitingPageEvent,
  readHostBlockingRequestsSnapshot,
  resetGlobalBlockingRequests,
} from '@/sync/global-blocking-requests';

const session = (id: string, parentID?: string, directory = '/project', projectID = 'project'): Session => ({
  id, parentID, projectID, directory, title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
});

const Harness = () => {
  useTraySync();
  return null;
};

describe('Dock badge with the macOS menu bar disabled', () => {
  let dom: Window;
  let root: Root;
  const counts: number[] = [];
  let listenerCount = 0;
  let intervalCount = 0;
  const invoke = async (command: string, args?: { dockBadgeCount?: number }) => {
    expect(command).toBe('desktop_tray_update');
    if (args?.dockBadgeCount !== undefined) counts.push(args.dockBadgeCount);
    return null;
  };
  const listen = async () => { listenerCount += 1; return () => {}; };
  const intervals = () => { intervalCount += 1; return 1; };
  let clock = 1;
  const patchSession = (id: string, patch: (time: Session['time']) => Session['time']) => useGlobalSessionsStore.setState((state) => ({
    activeSessions: state.activeSessions.map((item) => (item.id === id ? { ...item, time: patch(item.time) } : item)),
  }));
  // A turn ends: OpenCode stamps `time.idle`, which leaves the session unread.
  const finishTurn = (id: string) => patchSession(id, (time) => ({ ...time, idle: ++clock }));
  const view = (id: string) => patchSession(id, (time) => ({ ...time, viewed: time.idle }));
  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(dom, {
      __OPENCHAMBER_PLATFORM__: 'darwin',
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron', trayEnabled: false },
      __OPENCHAMBER_DESKTOP__: { invoke, listen },
      setInterval: intervals,
    });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }] });
    useGlobalSessionsStore.setState({ activeSessions: [session('root'), session('child', 'root')] });
    useUIStore.setState({ dockBadgeEnabled: true, notifyOnSubtasks: false });
    counts.length = 0;
    listenerCount = 0;
    intervalCount = 0;
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useProjectsStore.setState({ projects: [] });
    await dom.happyDOM.close();
  });

  test('counts only chats the sidebar lists, so every count can be cleared', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [
        session('root'),
        session('elsewhere', undefined, '/tmp/eval-run'),
        { ...session('btw-fork'), metadata: { openchamber: { kind: 'btw', originalSessionID: 'root' } } },
        { ...session('archived'), time: { created: 1, updated: 1, archived: 5 } },
      ],
    });
    for (const id of ['root', 'elsewhere', 'btw-fork', 'archived']) finishTurn(id);
    await act(async () => root.render(<Harness />));
    expect(counts).toEqual([1]);
    // Removing the project takes its sessions out of the sidebar and the count.
    useProjectsStore.setState({ projects: [] });
    await flush();
    expect(counts).toEqual([1, 0]);
  });

  test('publishes unread chats, clears viewed chats, and respects the badge toggle without tray timers or listeners', async () => {
    await act(async () => root.render(<Harness />));
    expect(counts).toEqual([0]);
    finishTurn('root');
    await flush();
    expect(counts).toEqual([0, 1]);
    useUIStore.setState({ dockBadgeEnabled: false });
    await flush();
    expect(counts).toEqual([0, 1, 0]);
    useUIStore.setState({ dockBadgeEnabled: true });
    await flush();
    expect(counts).toEqual([0, 1, 0, 1]);
    view('root');
    await flush();
    expect(counts).toEqual([0, 1, 0, 1, 0]);
    expect(intervalCount).toBe(0);
    expect(listenerCount).toBe(0);
  });

  test('never counts a subtask and reconciles global session membership', async () => {
    useUIStore.setState({ notifyOnSubtasks: true });
    finishTurn('child');
    await act(async () => root.render(<Harness />));
    expect(counts).toEqual([0]);
    finishTurn('root');
    await flush();
    expect(counts).toEqual([0, 1]);
    useGlobalSessionsStore.setState({ activeSessions: [] });
    await flush();
    expect(counts).toEqual([0, 1, 0]);
  });

  test('coalesces unread updates and cancels pending updates on unmount', async () => {
    await act(async () => root.render(<Harness />));
    finishTurn('root');
    finishTurn('root');
    await flush();
    expect(counts).toEqual([0, 1]);
    finishTurn('root');
    await flush();
    expect(counts).toEqual([0, 1]);
    view('root');
    await act(async () => root.unmount());
    await flush();
    expect(counts).toEqual([0, 1]);
    finishTurn('root');
    await flush();
    expect(counts).toEqual([0, 1]);
  });

  test('counts all unread chats at startup, beyond the tray menu limit', async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => session(`root-${index}`));
    useGlobalSessionsStore.setState({ activeSessions: sessions });
    for (const item of sessions) finishTurn(item.id);
    await act(async () => root.render(<Harness />));
    expect(counts).toEqual([25]);
  });

  test('starts with a cleared badge when both controls are disabled', async () => {
    finishTurn('root');
    useUIStore.setState({ dockBadgeEnabled: false });
    await act(async () => root.render(<Harness />));
    expect(counts).toEqual([0]);
    expect(intervalCount).toBe(0);
    expect(listenerCount).toBe(0);
  });

  test('does not publish desktop state outside Electron', async () => {
    Object.assign(dom, { __OPENCHAMBER_ELECTRON__: undefined });
    await act(async () => root.render(<Harness />));
    finishTurn('root');
    await flush();
    expect(counts).toEqual([]);
    expect(intervalCount).toBe(0);
    expect(listenerCount).toBe(0);
  });
});

// #4698: the tray drops "Allow always" when a permission carries no save
// patterns, so every approval source has to carry the flag. The cross-directory
// index feeds the tray from two inputs — live events and the host seed — and the
// seed is the one that arrives already parsed.
describe('tray approvals carry whether a permission can be remembered', () => {
  let dom: Window;
  let root: Root;
  const snapshots: Array<{ approvals?: Array<{ id: string; canSave: boolean }> }> = [];
  const invoke = async (command: string, args?: { approvals?: Array<{ id: string; canSave: boolean }> }) => {
    if (command === 'desktop_tray_update') snapshots.push(args as never);
    return null;
  };
  const listen = async () => () => {};
  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  };
  const canSaveById = () => Object.fromEntries(
    (snapshots.at(-1)?.approvals ?? []).map((a) => [a.id, a.canSave]),
  );

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(dom, {
      __OPENCHAMBER_PLATFORM__: 'darwin',
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron', trayEnabled: true },
      __OPENCHAMBER_DESKTOP__: { invoke, listen },
    });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    resetGlobalBlockingRequests();
    useGlobalSessionsStore.setState({ activeSessions: [session('root')] });
    useUIStore.setState({ dockBadgeEnabled: true, notifyOnSubtasks: false });
    snapshots.length = 0;
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resetGlobalBlockingRequests();
    await dom.happyDOM.close();
  });

  test('a live ask keeps its save patterns through to the tray', async () => {
    await act(async () => root.render(<Harness />));
    applyGlobalBlockingRequestEvents('/repo', [
      { type: 'permission.asked', properties: { id: 'live-save', sessionID: 'root', action: 'bash', resources: ['git status'], save: ['git *'] } },
      { type: 'permission.asked', properties: { id: 'live-once', sessionID: 'root', action: 'bash', resources: ['rm -rf tmp'] } },
    ]);
    await flush();

    expect(canSaveById()).toEqual({ 'live-save': true, 'live-once': false });
  });

  test('a seeded ask does too, so an unopened directory does not lose the option', async () => {
    await act(async () => root.render(<Harness />));
    await readHostBlockingRequestsSnapshot(async () => ({
      sessions: {},
      pending: { root: {
        permissions: [
          { id: 'seed-save', sessionID: 'root', action: 'bash', resources: ['git status'], save: ['git *'] },
          { id: 'seed-once', sessionID: 'root', action: 'bash', resources: ['rm -rf tmp'] },
        ],
        forms: [],
        pages: [],
      } },
      serverTime: 0,
    }), () => '/unopened');
    await flush();

    expect(canSaveById()).toEqual({ 'seed-save': true, 'seed-once': false });
  });

  test('a complete host snapshot removes an answered page from tray approvals', async () => {
    await act(async () => root.render(<Harness />));
    applyWaitingPageEvent({
      type: 'openchamber.page-waiting',
      properties: { sessionID: 'root', directory: '/repo', page: { id: 'answered-page', title: 'Services page binding' } },
    }, () => null);
    await flush();
    expect(canSaveById()).toEqual({ 'answered-page': false });

    await readHostBlockingRequestsSnapshot(async () => ({ sessions: {}, pending: {}, serverTime: Date.now() }), () => '/repo');
    await flush();
    expect(canSaveById()).toEqual({});
  });
});

type TraySnapshotForTest = {
  sessions?: Array<{ id: string }>;
  approvals?: Array<{ id: string }>;
  dockBadgeCount?: number;
};

// The tray is a short recent-work list, so it names the sessions the sidebar
// can show. A session whose directory belongs to no configured project (an
// eval run in /tmp, say) has no row there; it must not take a tray slot or a
// place in the dock badge, which the user could never clear.
describe('Tray sessions follow the configured projects', () => {
  let dom: Window;
  let root: Root;
  const snapshots: TraySnapshotForTest[] = [];
  const invoke = async (command: string, args?: TraySnapshotForTest) => {
    if (command === 'desktop_tray_update') snapshots.push(args ?? {});
    return null;
  };
  const listen = async () => () => {};
  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  };
  const lastSnapshot = () => snapshots.at(-1);

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(dom, {
      __OPENCHAMBER_PLATFORM__: 'darwin',
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron', trayEnabled: true },
      __OPENCHAMBER_DESKTOP__: { invoke, listen },
    });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    resetGlobalBlockingRequests();
    useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }] });
    useGlobalSessionsStore.setState({
      activeSessions: [
        session('in-project'),
        session('elsewhere', undefined, '/tmp/eval-run'),
      ],
    });
    useUIStore.setState({ dockBadgeEnabled: true, notifyOnSubtasks: false });
    snapshots.length = 0;
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resetGlobalBlockingRequests();
    useProjectsStore.setState({ projects: [] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
    await dom.happyDOM.close();
  });

  test('lists a project session but not one from an unconfigured directory', async () => {
    // Both finished a turn nobody has viewed yet; only the listed one counts.
    useGlobalSessionsStore.setState((state) => ({
      activeSessions: state.activeSessions.map((item) => ({ ...item, time: { ...item.time, idle: 2 } })),
    }));
    await act(async () => root.render(<Harness />));
    await flush();
    expect(lastSnapshot()?.sessions?.map((entry) => entry.id)).toEqual(['in-project']);
    expect(lastSnapshot()?.dockBadgeCount).toBe(1);
  });

  test('keeps a managed chat and an isolated space session', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [
        session('chat', undefined, '/tmp/chats', CHAT_DRAFT_PROJECT_ID),
        session('space', undefined, '/spaces/a1b2c3d4e5f6/app'),
        session('elsewhere', undefined, '/tmp/eval-run'),
      ],
    });
    await act(async () => root.render(<Harness />));
    await flush();
    expect(lastSnapshot()?.sessions?.map((entry) => entry.id).sort()).toEqual(['chat', 'space']);
  });

  test('keeps a session inside a configured project worktree', async () => {
    // Managed worktrees live outside the project root, so only the worktree
    // map can resolve this directory; a path under /project would pass on the
    // project-prefix rule alone and pin nothing.
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map([
        ['/project', [{ path: '/opencode-worktrees/run-1', projectDirectory: '/project', branch: 'run-1', label: 'run-1' }]],
      ]),
    });
    useGlobalSessionsStore.setState({
      activeSessions: [
        session('in-worktree', undefined, '/opencode-worktrees/run-1'),
        session('elsewhere', undefined, '/tmp/eval-run'),
      ],
    });
    await act(async () => root.render(<Harness />));
    await flush();
    expect(lastSnapshot()?.sessions?.map((entry) => entry.id)).toEqual(['in-worktree']);
  });

  test('keeps an in-work or pinned session whose project is gone, as the sidebar zones do', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [
        { ...session('in-work', undefined, '/tmp/removed'), metadata: { openchamber: { work: { state: 'open' } } } },
        session('pinned', undefined, '/tmp/removed-too'),
        session('elsewhere', undefined, '/tmp/eval-run'),
      ],
    });
    const pinKey = getPinnedSessionKey(getRuntimeKey(), '/tmp/removed-too', 'pinned');
    useSessionPinnedStore.setState({ ids: new Set(pinKey ? [pinKey] : []) });
    await act(async () => root.render(<Harness />));
    await flush();
    expect(lastSnapshot()?.sessions?.map((entry) => entry.id).sort()).toEqual(['in-work', 'pinned']);
    useSessionPinnedStore.setState({ ids: new Set() });
  });

  test('drops a /btw fork, which the sidebar never lists', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [
        session('in-project'),
        { ...session('btw-fork'), metadata: { openchamber: { kind: 'btw', originalSessionID: 'in-project' } } },
      ],
    });
    await act(async () => root.render(<Harness />));
    await flush();
    expect(lastSnapshot()?.sessions?.map((entry) => entry.id)).toEqual(['in-project']);
  });

  test('still lists a pending approval from a session it hides', async () => {
    await act(async () => root.render(<Harness />));
    applyGlobalBlockingRequestEvents('/tmp/eval-run', [
      { type: 'permission.asked', properties: { id: 'orphan-ask', sessionID: 'elsewhere', action: 'bash', resources: ['rm -rf tmp'] } },
    ]);
    await flush();
    expect(lastSnapshot()?.approvals?.map((entry) => entry.id)).toEqual(['orphan-ask']);
  });
});
