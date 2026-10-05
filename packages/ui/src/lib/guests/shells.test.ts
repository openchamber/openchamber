import { beforeEach, describe, expect, test } from 'bun:test';
import { GUEST_SHELLS_MAX } from '@openchamber/sdk';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useBackgroundShellsStore, type TrackedShell } from '@/sync/background-shells';
import { observeGuestShells, readGuestShells } from './shells';

const session = (id: string, directory: string, projectID: string, parentID?: string): Session => ({
  id, directory, title: id, projectID, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...(parentID ? { parentID } : {}),
});
const shell = (id: string, sessionID: string, startedAt: number, background: boolean): TrackedShell => ({
  id, sessionID, command: `run ${id}`, startedAt, directory: '/repo', background, file: 'shell.log',
});

beforeEach(() => {
  useProjectsStore.setState({ hasServerSnapshot: true, serverSnapshotFailed: false, projects: [{ id: 'path_/repo', path: '/repo', label: 'Repo', addedAt: 1 }] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([['/repo', [{ path: '/repo-tree', projectDirectory: '/repo', branch: 'fix', name: 'fix', label: 'fix', worktreeStatus: 'ready' }]]]) });
  useGlobalSessionsStore.getState().applySnapshot([
    session('root', '/repo', 'opencode-app'),
    session('child', '/repo', 'opencode-app', 'root'),
    session('tree', '/repo-tree', 'opencode-app'),
    session('other', '/other', 'opencode-other'),
  ], [], 'ready');
  useBackgroundShellsStore.setState({
    byId: new Map([
      ['sh_1', shell('sh_1', 'root', 2, true)],
      ['sh_2', shell('sh_2', 'child', 1, true)],
      ['sh_3', shell('sh_3', 'other', 3, true)],
      ['sh_4', shell('sh_4', 'root', 4, false)],
      ['sh_5', shell('sh_5', 'ghost', 5, true)],
      ['sh_6', shell('sh_6', 'tree', 6, true)],
    ]),
    sessionIds: new Set(['root', 'child', 'tree', 'other', 'ghost']),
  });
});

describe('extension shells projection', () => {
  test('a session scope lists the tree oldest first and keeps the background flag', () => {
    const snapshot = readGuestShells({ kind: 'session', sessionId: 'root' });
    expect(snapshot.kind).toBe('shells');
    expect(snapshot.scope).toEqual({ kind: 'session', sessionId: 'root' });
    expect(snapshot.shells.map((entry) => entry.id)).toEqual(['sh_2', 'sh_1', 'sh_4']);
    expect(snapshot.shells.find((entry) => entry.id === 'sh_4')?.background).toBe(false);
  });

  test('a project scope covers the project root and its worktrees, whatever the session project ids are', () => {
    const snapshot = readGuestShells({ kind: 'project', projectId: 'path_/repo' });
    expect(snapshot.scope).toEqual({ kind: 'project', projectId: 'path_/repo' });
    expect(snapshot.shells.map((entry) => entry.id)).toEqual(['sh_2', 'sh_1', 'sh_4', 'sh_6']);
    expect(readGuestShells({ kind: 'project', projectId: 'path_/nope' }).shells).toEqual([]);
    expect(() => observeGuestShells({ kind: 'project', projectId: 'path_/nope' }, () => {})).toThrow();
  });

  test('a global scope lists every shell, including sessions the store does not know', () => {
    expect(readGuestShells({ kind: 'global' }).shells.map((entry) => entry.id)).toEqual(['sh_2', 'sh_1', 'sh_3', 'sh_4', 'sh_5', 'sh_6']);
  });

  test('caps the projection at the documented shell bound', () => {
    const byId = new Map<string, TrackedShell>();
    for (let index = 0; index < GUEST_SHELLS_MAX + 50; index += 1) {
      byId.set(`sh_${index}`, shell(`sh_${index}`, 'root', index, true));
    }
    useBackgroundShellsStore.setState({ byId, sessionIds: new Set(['root']) });
    expect(readGuestShells({ kind: 'session', sessionId: 'root' }).shells).toHaveLength(GUEST_SHELLS_MAX);
  });

  test('observers replay the current snapshot and publish changes', async () => {
    const seen: string[][] = [];
    const stop = observeGuestShells({ kind: 'session', sessionId: 'root' }, (snapshot) => seen.push(snapshot.shells.map((entry) => entry.id)));
    try {
      expect(seen).toEqual([['sh_2', 'sh_1', 'sh_4']]);
      useBackgroundShellsStore.setState((state) => {
        const byId = new Map(state.byId);
        byId.delete('sh_1');
        return { byId, sessionIds: new Set(['root', 'child', 'tree', 'other', 'ghost']) };
      });
      await Promise.resolve();
      expect(seen.at(-1)).toEqual(['sh_2', 'sh_4']);
    } finally {
      stop();
    }
  });

  test('a project observer goes empty when the project leaves the registry', async () => {
    const seen: string[][] = [];
    const stop = observeGuestShells({ kind: 'project', projectId: 'path_/repo' }, (snapshot) => seen.push(snapshot.shells.map((entry) => entry.id)));
    try {
      expect(seen).toEqual([['sh_2', 'sh_1', 'sh_4', 'sh_6']]);
      useProjectsStore.setState({ hasServerSnapshot: true, serverSnapshotFailed: false, projects: [] });
      await Promise.resolve();
      expect(seen.at(-1)).toEqual([]);
    } finally {
      stop();
    }
  });
});
