import { beforeEach, describe, expect, test } from 'bun:test';
import type { RunningShell, ShellEnd } from '@/lib/opencode/background-shell';
import type { SyncEvent } from '@/lib/opencode/events';
import {
  ENDED_SHELLS_MAX,
  applyBackgroundShellEvents,
  backgroundShellRevision,
  directoriesWithRunningShells,
  refreshBackgroundShells,
  replaceDirectoryShells,
  resetBackgroundShells,
  sessionsInTree,
  backgroundShellsOfSessions,
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
const ended = (shellID: string, end: ShellEnd = { kind: 'exited', status: 'exited', exit: 0 }, endedAt = 5000): SyncEvent => (
  { type: 'shell.ended', properties: { shellID, end, endedAt } }
);
const endedIds = () => [...useBackgroundShellsStore.getState().ended.keys()];
// The call that started a command settles while it runs: it went to the background.
const settledInBackground = (shellID: string): SyncEvent => ({
  type: 'message.tool.transition',
  properties: {
    sessionID: 'ses_1',
    messageID: 'msg_1',
    partID: `call_${shellID}`,
    transition: { kind: 'success', output: '', metadata: { status: 'running', shellID }, executed: true, end: 2000 },
  },
});
const isBackground = (shellID: string) => useBackgroundShellsStore.getState().byId.get(shellID)?.background;

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

describe('ended commands', () => {
  test('an exit keeps the command with its status, exit code and end time', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_1')), settledInBackground('sh_1')]);
    applyBackgroundShellEvents('/repo', [ended('sh_1', { kind: 'exited', status: 'exited', exit: 2 }, 7000)]);
    expect(useBackgroundShellsStore.getState().ended.get('sh_1')).toEqual({
      ...shell('sh_1'), directory: '/repo', background: true, status: 'exited', exit: 2, endedAt: 7000,
    });
  });

  test('a running command removed is stopped; an exited one removed later stays exited', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_stop')), started(shell('sh_done'))]);
    applyBackgroundShellEvents('/repo', [
      ended('sh_stop', { kind: 'removed' }),
      ended('sh_done', { kind: 'exited', status: 'timeout' }),
      ended('sh_done', { kind: 'removed' }),
    ]);
    const { ended: byId } = useBackgroundShellsStore.getState();
    expect(byId.get('sh_stop')?.status).toBe('stopped');
    expect(byId.get('sh_done')?.status).toBe('timeout');
    expect(byId.get('sh_done')?.exit).toBeUndefined();
  });

  test('after a stop note, the kill that ends the command reads as stopped; an exit with a code does not', () => {
    const note = (shellID: string): SyncEvent => ({
      type: 'message.updated',
      properties: { info: { id: `msg_${shellID}`, sessionID: 'ses_1', role: 'synthetic', text: 'stopped', metadata: { openchamberShellCancellation: { shellID } }, time: { created: 3000 } } },
    });
    applyBackgroundShellEvents('/repo', [started(shell('sh_killed')), started(shell('sh_survived'))]);
    applyBackgroundShellEvents('/repo', [
      note('sh_killed'),
      note('sh_survived'),
      // OpenCode reports the kill as an exit without a code, before the removal.
      ended('sh_killed', { kind: 'exited', status: 'exited' }),
      ended('sh_killed', { kind: 'removed' }),
      ended('sh_survived', { kind: 'exited', status: 'exited', exit: 0 }),
    ]);
    const { ended: byId } = useBackgroundShellsStore.getState();
    expect(byId.get('sh_killed')?.status).toBe('stopped');
    expect(byId.get('sh_survived')?.status).toBe('exited');
  });

  test('without a stop note, an exit without a code stays an exit', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_1'))]);
    applyBackgroundShellEvents('/repo', [ended('sh_1', { kind: 'exited', status: 'exited' })]);
    expect(useBackgroundShellsStore.getState().ended.get('sh_1')?.status).toBe('exited');
  });

  test('a command a list no longer has ended without a known status', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_gap'))]);
    replaceDirectoryShells('/repo', [], backgroundShellRevision());
    expect(useBackgroundShellsStore.getState().ended.get('sh_gap')?.status).toBe('unknown');
  });

  test('an end the index never saw running records nothing', () => {
    applyBackgroundShellEvents('/repo', [ended('sh_unknown')]);
    expect(endedIds()).toEqual([]);
  });

  test('only the latest ends are kept, and a runtime switch forgets them', () => {
    const count = ENDED_SHELLS_MAX + 5;
    const ids = Array.from({ length: count }, (_, index) => `sh_${index}`);
    applyBackgroundShellEvents('/repo', ids.map((id) => started(shell(id))));
    applyBackgroundShellEvents('/repo', ids.map((id, index) => ended(id, undefined, index)));
    expect(endedIds()).toEqual(ids.slice(5));
    resetBackgroundShells();
    expect(endedIds()).toEqual([]);
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

  test('background commands of the chosen sessions, oldest first', () => {
    applyBackgroundShellEvents('/repo', [
      started({ ...shell('sh_late', 'ses_child'), startedAt: 3000 }),
      started({ ...shell('sh_early', 'ses_root'), startedAt: 1000 }),
      started({ ...shell('sh_foreign', 'ses_other'), startedAt: 2000 }),
      started({ ...shell('sh_waited', 'ses_root'), startedAt: 1500 }),
      settledInBackground('sh_late'),
      settledInBackground('sh_early'),
      settledInBackground('sh_foreign'),
    ]);
    const picked = backgroundShellsOfSessions(useBackgroundShellsStore.getState().byId, new Set(['ses_root', 'ses_child']));
    expect(picked.map((item) => item.id)).toEqual(['sh_early', 'sh_late']);
  });
});

describe('background or waited for', () => {
  test('a command the turn waits for is tracked, but not as background', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_1'))]);
    expect(isBackground('sh_1')).toBe(false);
    // The turn still counts it as running work.
    expect(sessions()).toEqual(['ses_1']);
  });

  test('its call settling while it runs moves it to the background, once', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_1'))]);
    applyBackgroundShellEvents('/repo', [settledInBackground('sh_1')]);
    expect(isBackground('sh_1')).toBe(true);
    const before = useBackgroundShellsStore.getState();
    applyBackgroundShellEvents('/repo', [settledInBackground('sh_1'), started(shell('sh_1'))]);
    expect(useBackgroundShellsStore.getState()).toBe(before);
  });

  test('a call that settles with its result does not', () => {
    applyBackgroundShellEvents('/repo', [
      started(shell('sh_1')),
      {
        type: 'message.tool.transition',
        properties: {
          sessionID: 'ses_1', messageID: 'msg_1', partID: 'call_1',
          transition: { kind: 'success', output: 'done', metadata: { shellID: 'sh_1', exit: 0 }, executed: true, end: 2000 },
        },
      },
    ]);
    expect(isBackground('sh_1')).toBe(false);
  });

  test('a settlement that arrives before the start still counts', () => {
    applyBackgroundShellEvents('/repo', [settledInBackground('sh_1')]);
    applyBackgroundShellEvents('/repo', [started(shell('sh_1'))]);
    expect(isBackground('sh_1')).toBe(true);
  });

  test('a command first seen in a list counts as background; a known one keeps what its events said', () => {
    applyBackgroundShellEvents('/repo', [started(shell('sh_waited'))]);
    replaceDirectoryShells('/repo', [shell('sh_waited'), shell('sh_listed')], backgroundShellRevision());
    expect(isBackground('sh_listed')).toBe(true);
    expect(isBackground('sh_waited')).toBe(false);
  });
});
