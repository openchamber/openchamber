import { beforeEach, describe, expect, test } from 'bun:test';
import type { RunningShell } from '@/lib/opencode/background-shell';
import type { SyncEvent } from '@/lib/opencode/events';
import {
  applyBackgroundShellEvents,
  backgroundShellRevision,
  directoriesWithRunningShells,
  refreshBackgroundShells,
  replaceDirectoryShells,
  resetBackgroundShells,
  sessionsInTree,
  shellsOfSessions,
  useBackgroundShellsStore,
} from './background-shells';

const shell = (id: string, sessionID = 'ses_1'): RunningShell => ({
  id,
  sessionID,
  command: `run ${id}`,
  file: `/tmp/${id}.out`,
  startedAt: 1000,
});

const started = (value: RunningShell): SyncEvent => ({ type: 'shell.started', properties: { shell: value } });
const ended = (shellID: string): SyncEvent => ({ type: 'shell.ended', properties: { shellID } });

const ids = () => [...useBackgroundShellsStore.getState().byId.keys()].sort();
const sessions = () => [...useBackgroundShellsStore.getState().sessionIds].sort();

beforeEach(() => resetBackgroundShells());

describe('background shell index', () => {
  test('tracks commands per session from start to end', () => {
    applyBackgroundShellEvents('/repo/', [started(shell('sh_1')), started(shell('sh_2', 'ses_2'))]);
    expect(ids()).toEqual(['sh_1', 'sh_2']);
    expect(sessions()).toEqual(['ses_1', 'ses_2']);
    expect(useBackgroundShellsStore.getState().byId.get('sh_1')?.directory).toBe('/repo');
    expect(directoriesWithRunningShells()).toEqual(['/repo']);

    applyBackgroundShellEvents('/repo', [ended('sh_1')]);
    expect(sessions()).toEqual(['ses_2']);
  });

  test('a repeated start or an unknown end publishes nothing', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_1'))]);
    const before = useBackgroundShellsStore.getState();
    applyBackgroundShellEvents('/repo', [started(shell('sh_1')), ended('sh_9'), { type: 'session.idle', properties: { sessionID: 'ses_1' } }]);
    expect(useBackgroundShellsStore.getState()).toBe(before);
  });

  test('a list replaces its own directory only', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_1'))]);
    applyBackgroundShellEvents('/other', [started(shell('sh_2', 'ses_2'))]);
    replaceDirectoryShells('/repo', [shell('sh_3')], backgroundShellRevision());
    expect(ids()).toEqual(['sh_2', 'sh_3']);
  });

  test('events that arrive while a list is read win over the list', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_old'))]);
    const since = backgroundShellRevision();
    // While the read is in flight: one command starts, the listed one ends.
    applyBackgroundShellEvents('/repo', [started(shell('sh_new')), ended('sh_listed')]);
    replaceDirectoryShells('/repo', [shell('sh_listed')], since);
    expect(ids()).toEqual(['sh_new']);
  });

  test('a failed read changes nothing', async () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_1'))]);
    await expect(refreshBackgroundShells('/repo', async () => {
      throw new Error('offline');
    })).rejects.toThrow('offline');
    expect(ids()).toEqual(['sh_1']);
  });

  test('a read that started before a runtime switch does not commit', async () => {
    let resolve: (listed: { directory: string; shells: RunningShell[] }) => void = () => undefined;
    const pending = refreshBackgroundShells('/repo', () => new Promise((done) => { resolve = done; }));
    resetBackgroundShells();
    resolve({ directory: '/repo', shells: [shell('sh_stale')] });
    await pending;
    expect(ids()).toEqual([]);
  });

  test('a list replaces the directory OpenCode answered for, which its events carry', async () => {
    applyBackgroundShellEvents('/private/tmp/repo', [started(shell('sh_exited'))]);
    await refreshBackgroundShells('/tmp/repo', async () => ({ directory: '/private/tmp/repo', shells: [] }));
    expect(ids()).toEqual([]);
  });
});

describe('commands of a session tree', () => {
  const parents = new Map<string, string>([
    ['ses_child', 'ses_root'],
    ['ses_grandchild', 'ses_child'],
    ['ses_other_child', 'ses_other'],
    ['ses_loop_a', 'ses_loop_b'],
    ['ses_loop_b', 'ses_loop_a'],
  ]);
  const parentOf = (id: string) => parents.get(id);

  test('a session and its subagents at any depth, nothing else', () => {
    const candidates = ['ses_root', 'ses_grandchild', 'ses_child', 'ses_other_child', 'ses_unknown'];
    expect(sessionsInTree(candidates, 'ses_root', parentOf)).toEqual(['ses_child', 'ses_grandchild', 'ses_root']);
  });

  test('a parent cycle ends instead of looping', () => {
    expect(sessionsInTree(['ses_loop_a'], 'ses_root', parentOf)).toEqual([]);
  });

  test('commands of the chosen sessions, oldest first', () => {
    applyBackgroundShellEvents('/repo', [
      started({ ...shell('sh_late', 'ses_child'), startedAt: 3000 }),
      started({ ...shell('sh_early', 'ses_root'), startedAt: 1000 }),
      started({ ...shell('sh_foreign', 'ses_other'), startedAt: 2000 }),
    ]);
    const picked = shellsOfSessions(useBackgroundShellsStore.getState().byId, new Set(['ses_root', 'ses_child']));
    expect(picked.map((item) => item.id)).toEqual(['sh_early', 'sh_late']);
  });
});
