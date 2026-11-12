import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { GUEST_SHELLS_MAX, HostRequestError } from '@openchamber/sdk';
import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useBackgroundShellsStore, type EndedShell, type TrackedShell } from '@/sync/background-shells';
import { observeGuestShells, readGuestShellOutput, readGuestShells } from './shells';

const session = (id: string, directory: string, projectID: string, parentID?: string): Session => ({
  id, directory, title: id, projectID, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...(parentID ? { parentID } : {}),
});
const shell = (id: string, sessionID: string, startedAt: number, background: boolean): TrackedShell => ({
  id, sessionID, command: `run ${id}`, startedAt, directory: '/repo', background, file: 'shell.log',
});
const ended = (id: string, sessionID: string, end: Pick<EndedShell, 'status' | 'exit' | 'endedAt'>): EndedShell => (
  end.exit === undefined
    ? { ...shell(id, sessionID, 1, true), status: end.status, endedAt: end.endedAt }
    : { ...shell(id, sessionID, 1, true), status: end.status, exit: end.exit, endedAt: end.endedAt }
);

beforeEach(() => {
  useProjectsStore.setState({ hasServerSnapshot: true, serverSnapshotFailed: false, projects: [{ id: 'path_/repo', path: '/repo', label: 'Repo', addedAt: 1 }] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([['/repo', [{ path: '/repo-tree', projectDirectory: '/repo', branch: 'fix', name: 'fix', label: 'fix', worktreeStatus: 'ready' }]]]) });
  useGlobalSessionsStore.getState().applySnapshot([
    session('root', '/repo', 'opencode-app'),
    session('child', '/repo', 'opencode-app', 'root'),
    session('grandchild', '/repo', 'opencode-app', 'child'),
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
    ended: new Map([
      ['sh_done', ended('sh_done', 'grandchild', { status: 'exited', exit: 1, endedAt: 20 })],
      ['sh_stopped', ended('sh_stopped', 'root', { status: 'stopped', endedAt: 10 })],
      ['sh_elsewhere', ended('sh_elsewhere', 'other', { status: 'timeout', endedAt: 30 })],
    ]),
  });
});

describe('ended shells in the projection', () => {
  test('a session scope lists its tree\'s ended shells oldest end first, with exit codes', () => {
    const snapshot = readGuestShells({ kind: 'session', sessionId: 'root' });
    expect(snapshot.ended).toEqual([
      { id: 'sh_stopped', sessionID: 'root', command: 'run sh_stopped', startedAt: 1, background: true, status: 'stopped', endedAt: 10 },
      { id: 'sh_done', sessionID: 'grandchild', command: 'run sh_done', startedAt: 1, background: true, status: 'exited', exit: 1, endedAt: 20 },
    ]);
  });

  test('keeps the newest ends at the documented bound', () => {
    const many = new Map<string, EndedShell>();
    for (let index = 0; index < GUEST_SHELLS_MAX + 10; index += 1) {
      many.set(`sh_${index}`, ended(`sh_${index}`, 'root', { status: 'exited', endedAt: index }));
    }
    useBackgroundShellsStore.setState({ ended: many });
    const snapshot = readGuestShells({ kind: 'global' });
    expect(snapshot.ended).toHaveLength(GUEST_SHELLS_MAX);
    expect(snapshot.ended[0]?.id).toBe('sh_10');
  });
});

/** The host error code a read failed with, or the error's name for any other failure. */
const failureOf = async (read: Promise<unknown>): Promise<string> => {
  try {
    await read;
    return 'resolved';
  } catch (error) {
    if (error instanceof HostRequestError) return error.code;
    return error instanceof Error ? error.name : 'non-error';
  }
};

describe('extension shell output', () => {
  test('reads a running or ended shell in the directory it ran in', async () => {
    const read = spyOn(opencodeClient, 'readShellOutput').mockResolvedValue({ output: 'ok', cursor: 2, skipped: false });
    try {
      expect(await readGuestShellOutput('sh_done', undefined, 100)).toEqual({ output: 'ok', cursor: 2, skipped: false });
      expect(read.mock.calls[0]).toEqual(['sh_done', '/repo', undefined, 100]);
    } finally {
      read.mockRestore();
    }
  });

  test('an unseen shell, a stopped one, and output OpenCode dropped are NOT_FOUND', async () => {
    const read = spyOn(opencodeClient, 'readShellOutput').mockRejectedValue(new OpencodeApiError('shell.output', 'gone', { status: 404 }));
    try {
      expect(await failureOf(readGuestShellOutput('sh_nope'))).toBe('NOT_FOUND');
      expect(await failureOf(readGuestShellOutput('sh_stopped'))).toBe('NOT_FOUND');
      expect(await failureOf(readGuestShellOutput('sh_done'))).toBe('NOT_FOUND');
      expect(read.mock.calls).toHaveLength(1);
    } finally {
      read.mockRestore();
    }
  });

  test('any other failure is passed on, not reported as missing', async () => {
    const read = spyOn(opencodeClient, 'readShellOutput').mockRejectedValue(new OpencodeApiError('shell.output', 'boom', { status: 500 }));
    try {
      expect(await failureOf(readGuestShellOutput('sh_1'))).toBe('OpencodeApiError');
    } finally {
      read.mockRestore();
    }
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
