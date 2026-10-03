import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { createRuntimeOpencodeClient } from '@/lib/opencode/client';
import { applyGlobalSessionStatusEvent, replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { readGuestWorkspace, observeGuestWorkspace } from './workspace';
import { guestMay } from './capabilities';

const session = (id: string, directory: string): Session => ({
  id, directory, title: id, projectID: 'upstream', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});
let manager: ChildStoreManager;
beforeEach(() => {
  manager = new ChildStoreManager();
  setSyncRefs(createRuntimeOpencodeClient({ baseUrl: 'http://localhost' }), manager, '/a');
  useProjectsStore.setState({ hasServerSnapshot: true, serverSnapshotFailed: false, projects: [
    { id: 'a', path: '/a', label: 'A', addedAt: 1 }, { id: 'b', path: '/b', label: 'B', addedAt: 1 },
  ] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([['/b', [{ path: '/b-tree', projectDirectory: '/b', branch: 'fix', name: 'fix', label: 'fix', worktreeStatus: 'ready' }]]]), worktreeDiscoveryByProject: new Map([['/a', 'ready'], ['/b', 'ready']]) });
  useGlobalSessionsStore.getState().applySnapshot([session('a-session', '/a'), session('b-session', '/b-tree')], [], 'ready');
  useConfigStore.setState({ isConnected: true });
  // The legacy diagnostic field is not maintained by the current sync pipeline.
  useUIStore.setState({ eventStreamStatus: 'idle' });
  replaceGlobalSessionStatusById(new Map());
});
afterEach(() => manager.disposeAll());
const readB = () => {
  const snapshot = readGuestWorkspace({ kind: 'sessions', projectId: 'b' }, 'board');
  if (snapshot.kind !== 'sessions') throw new Error('Expected sessions');
  return snapshot;
};
describe('extension workspace projection', () => {
  test('paused and partially approved extensions cannot use retained grants', () => {
    expect(guestMay({ id: 'board', name: 'Board', icon: 'window', enabled: false,
      capabilities: { requested: ['sessions'], granted: ['sessions'] } }, 'sessions')).toBe(false);
    expect(guestMay({ id: 'board', name: 'Board', icon: 'window',
      capabilities: { requested: ['sessions', 'prompt'], granted: ['sessions'] } }, 'sessions')).toBe(false);
  });
  test('uses shared topology and never starts a network read', () => {
    const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    try {
      for (let i = 0; i < 100; i++) {
        const snapshot = readB();
        expect(snapshot.sessions.map((entry) => entry.id)).toEqual(['b-session']);
        expect(snapshot.sessions[0].worktree?.branch).toBe('fix');
        expect(snapshot.sessions[0].activity).toBe('unknown');
      }
      expect(fetch.mock.calls.length).toBe(0);
    } finally { fetch.mockRestore(); }
  });
  test('live outcomes work with the untouched diagnostic stream field and distinguish turn outcomes', () => {
    const store = manager.ensureChild('/b-tree', { bootstrap: false });
    store.setState({ sessionStatusReady: true });
    expect(readB().sessions[0]).toMatchObject({ activity: 'idle', outcome: null });
    applyGlobalSessionStatusEvent('/b-tree', { type: 'session.status', properties: { sessionID: 'b-session', status: { type: 'busy' } } });
    expect(readB().sessions[0]).toMatchObject({ activity: 'running', outcome: null });
    applyGlobalSessionStatusEvent('/b-tree', { type: 'session.error', properties: { sessionID: 'b-session', error: { type: 'UnknownError', message: 'Failed' } } });
    applyGlobalSessionStatusEvent('/b-tree', { type: 'session.idle', properties: { sessionID: 'b-session' } });
    expect(readB().sessions[0]).toMatchObject({ activity: 'idle', outcome: 'failed' });
    applyGlobalSessionStatusEvent('/b-tree', { type: 'session.status', properties: { sessionID: 'b-session', status: { type: 'busy' } } });
    applyGlobalSessionStatusEvent('/b-tree', { type: 'session.idle', properties: { sessionID: 'b-session' } });
    expect(readB().sessions[0]).toMatchObject({ activity: 'idle', outcome: 'completed' });
    useConfigStore.setState({ isConnected: false });
    expect(readB().sessions[0]).toMatchObject({ activity: 'unknown', outcome: null });
  });
  test('archive invalidation prevents old idle coverage and notifies guest subscribers', async () => {
    const child = manager.ensureChild('/b-tree', { bootstrap: false });
    child.setState({ sessionStatusReady: true });
    const activity: string[] = [];
    const stop = observeGuestWorkspace({ kind: 'sessions', projectId: 'b' }, 'board', (snapshot) => {
      if (snapshot.kind === 'sessions') activity.push(snapshot.sessions[0].activity);
    });
    try {
      expect(activity).toEqual(['idle']);
      child.setState({ sessionStatusInvalidated: { 'b-session': true } });
      await Promise.resolve();
      expect(readB().sessions[0]).toMatchObject({ activity: 'unknown', outcome: null });
      expect(activity).toEqual(['idle', 'unknown']);
      child.setState({ sessionStatusInvalidated: {} });
      await Promise.resolve();
      expect(activity).toEqual(['idle', 'unknown', 'idle']);
    } finally { stop(); }
  });
  test('worktree loading and errors retain data, and token updates do not publish', async () => {
    const snapshots: number[] = [];
    const stop = observeGuestWorkspace({ kind: 'sessions', projectId: 'b' }, 'board', () => snapshots.push(1));
    const child = manager.ensureChild('/b-tree', { bootstrap: false });
    await Promise.resolve();
    const baseline = snapshots.length;
    for (let i = 0; i < 100; i++) child.setState({ part: {} });
    await Promise.resolve();
    expect(snapshots.length).toBe(baseline);
    useSessionUIStore.setState({ worktreeDiscoveryByProject: new Map([['/b', 'error']]) });
    expect(readB()).toMatchObject({ state: 'error', sessions: [{ id: 'b-session' }] });
    await Promise.resolve();
    expect(snapshots.length).toBe(baseline + 1);
    stop();
    applyGlobalSessionStatusEvent('/b-tree', { type: 'session.status', properties: { sessionID: 'b-session', status: { type: 'busy' } } });
    await Promise.resolve();
    expect(snapshots.length).toBe(baseline + 1);
  });
  test('blocking requests and retries expose state without conversation data', () => {
    const child = manager.ensureChild('/b-tree', { bootstrap: false });
    applyGlobalSessionStatusEvent('/b-tree', { type: 'session.status', properties: { sessionID: 'b-session', status: { type: 'retry', attempt: 1, message: 'Wait', next: 1 } } });
    expect(readB().sessions[0].activity).toBe('retrying');
    child.setState({ permission: { 'b-session': [{ id: 'permission', sessionID: 'b-session', action: 'bash', resources: [] }] } });
    expect(readB().sessions[0].activity).toBe('waiting-permission');
    // v2's typed forms replaced the v1 question tool; the public activity value is unchanged.
    child.setState({ permission: {}, form: { 'b-session': [{ id: 'form', sessionID: 'b-session', title: 'Pick one', fields: [{ key: 'answer', type: 'boolean' }] }] } });
    expect(readB().sessions[0].activity).toBe('waiting-question');
    expect('messages' in readB().sessions[0]).toBe(false);
  });
});
