import { expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { createSessionNavigationHistory } from './sessionNavigationHistoryState';

const session = (id: string, directory = '/a'): Session => ({
  id, projectID: directory, directory, title: id,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});
const visit = (id: string) => ({ sessionId: id, directory: '/a' });
const fixture = (resolve: (id: string, signal: AbortSignal) => Promise<Session | null>
  = async (id) => session(id)) => {
  const selected: Session[] = [];
  const history = createSessionNavigationHistory({
    resolve: (entry, signal) => resolve(entry.sessionId, signal),
    select: (value) => { selected.push(value); },
  });
  history.setScope('server-a');
  return { history, selected };
};

test('chronology, nonconsecutive revisits and branching', async () => {
  const { history, selected } = fixture();
  ['A1', 'A2', 'B1'].forEach((id) => history.record(visit(id)));
  for (const delta of [-1, -1, 1, 1] as const) await history.navigate(delta);
  expect(selected.map((value) => value.id)).toEqual(['A2', 'A1', 'A2', 'B1']);
  await history.navigate(-1);
  history.record(visit('A2'));
  expect(history.getSnapshot().canGoForward).toBe(true);
  history.record(visit('C1'));
  expect(history.getSnapshot().canGoForward).toBe(false);
  await history.navigate(-1);
  expect(selected.at(-1)?.id).toBe('A2');
  history.record(visit('A1'));
  history.record(visit('B1'));
  history.record(visit('A1'));
  await history.navigate(-1);
  expect(selected.at(-1)?.id).toBe('B1');
});

test('retains exactly the last 100 visits and never wraps', async () => {
  const { history, selected } = fixture();
  for (let i = 0; i < 105; i += 1) history.record(visit(String(i)));
  for (let i = 0; i < 99; i += 1) expect(await history.navigate(-1)).toBe(true);
  expect(selected.at(-1)?.id).toBe('5');
  expect(await history.navigate(-1)).toBe(false);
  expect(history.getSnapshot().canGoBack).toBe(false);
});

test('revisiting a session retains its resolved worktree directory for later lookups', async () => {
  const destination = { ...session('A', ''), project: { worktree: '/worktree' } };
  const directories: Array<string | null> = [];
  const history = createSessionNavigationHistory({
    resolve: async (entry) => {
      if (entry.sessionId === 'A') directories.push(entry.directory);
      return entry.sessionId === 'A' ? destination : session('B');
    },
    select: () => {},
  });
  history.setScope('server-a');
  history.record({ sessionId: 'A', directory: '/worktree' });
  history.record(visit('B'));
  await history.navigate(-1);
  await history.navigate(1);
  destination.project.worktree = '/moved-worktree';
  await history.navigate(-1);
  await history.navigate(1);
  await history.navigate(-1);
  expect(directories).toEqual(['/worktree', '/worktree', '/moved-worktree']);
});

test('skips confirmed missing destinations but retries uncertain failures', async () => {
  let offline = true;
  const { history, selected } = fixture(async (id) => {
    if (id === 'gone') return null;
    if (offline) throw new Error('offline');
    return session(id, '/worktree');
  });
  ['A', 'gone', 'B'].forEach((id) => history.record(visit(id)));
  expect(await history.navigate(-1)).toBe(false);
  expect(selected).toEqual([]);
  expect(history.getSnapshot().errorRevision).toBe(1);
  expect(history.getSnapshot().canGoBack).toBe(true);
  offline = false;
  expect(await history.navigate(-1)).toBe(true);
  expect(selected[0]?.directory).toBe('/worktree');
});

test('last accepted rapid destination wins even when abort is ignored', async () => {
  let completeSlow: (value: Session) => void = () => { throw new Error('not started'); };
  const { history, selected } = fixture((id) => id === 'B'
    ? new Promise((resolve) => { completeSlow = resolve; })
    : Promise.resolve(session(id)));
  ['A', 'B', 'C'].forEach((id) => history.record(visit(id)));
  const slow = history.navigate(-1);
  await history.navigate(-1);
  completeSlow(session('B'));
  await slow;
  expect(selected.map((value) => value.id)).toEqual(['A']);
});

test('an opposite press during a pending transition returns to the current session', async () => {
  let finish: (value: Session) => void = () => { throw new Error('not started'); };
  const { history, selected } = fixture((id) => id === 'B'
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve(session(id)));
  ['A', 'B', 'C'].forEach((id) => history.record(visit(id)));
  const pendingBack = history.navigate(-1);
  // The pending target is the availability origin, so Forward is offered even
  // though the committed cursor is still the last visit.
  expect(history.getSnapshot().canGoForward).toBe(true);
  expect(await history.navigate(1)).toBe(true);
  finish(session('B'));
  expect(await pendingBack).toBe(false);
  expect(selected).toEqual([]);
  expect(history.getSnapshot().canGoForward).toBe(false);
  expect(history.getSnapshot().canGoBack).toBe(true);
});

test('a normal selection cancels a pending transition and its obsolete branch', async () => {
  let finish: (value: Session) => void = () => { throw new Error('not started'); };
  const { history, selected } = fixture(() => new Promise((resolve) => { finish = resolve; }));
  ['A', 'B'].forEach((id) => history.record(visit(id)));
  const pending = history.navigate(-1);
  history.record(visit('C'));
  finish(session('A'));
  await pending;
  expect(selected).toEqual([]);
  expect(history.getSnapshot().canGoForward).toBe(false);
});

test('drafts and disconnects suspend; same scope resumes; new scope resets', async () => {
  const { history, selected } = fixture();
  ['A', 'B'].forEach((id) => history.record(visit(id)));
  history.setBlocked(true);
  expect(await history.navigate(-1)).toBe(false);
  history.setBlocked(false);
  history.setScope(null);
  expect(history.getSnapshot().canGoBack).toBe(false);
  history.setScope('server-a');
  expect(history.getSnapshot().canGoBack).toBe(true);
  history.setScope('server-b');
  history.record(visit('B'));
  expect(history.getSnapshot().canGoBack).toBe(false);
  expect(selected).toEqual([]);
});

test('switching scope rejects an old response even with an identical session ID', async () => {
  let finish: (value: Session) => void = () => { throw new Error('not started'); };
  const { history, selected } = fixture(() => new Promise((resolve) => { finish = resolve; }));
  ['A', 'B'].forEach((id) => history.record(visit(id)));
  const pending = history.navigate(-1);
  history.setScope(null);
  history.setScope('server-b');
  history.record(visit('A'));
  finish(session('A', '/old-server'));
  await pending;
  expect(selected).toEqual([]);
  expect(history.getSnapshot().canGoBack).toBe(false);
});

test('exhausting confirmed unavailable visits disables that direction', async () => {
  const { history, selected } = fixture(async () => null);
  ['A', 'B', 'C'].forEach((id) => history.record(visit(id)));
  expect(await history.navigate(-1)).toBe(false);
  expect(history.getSnapshot().canGoBack).toBe(false);
  expect(selected).toEqual([]);
});

test('restoration while an unavailable lookup settles remains retryable', async () => {
  let available = false;
  let finish: (value: Session | null) => void = () => { throw new Error('not started'); };
  const selected: string[] = [];
  const history = createSessionNavigationHistory({
    resolve: async (entry) => available ? session(entry.sessionId)
      : new Promise<Session | null>((resolve) => { finish = resolve; }),
    select: (value) => { selected.push(value.id); },
    isKnownAvailable: () => available,
  });
  history.setScope('server-a');
  ['A', 'B'].forEach((id) => history.record(visit(id)));
  const pending = history.navigate(-1);
  available = true;
  history.refreshAvailability();
  finish(null);
  expect(await pending).toBe(false);
  expect(history.getSnapshot().canGoBack).toBe(true);
  expect(await history.navigate(-1)).toBe(true);
  expect(selected).toEqual(['A']);
});

test('metadata refresh checks only skipped visits and never resolves a destination', async () => {
  let availabilityChecks = 0;
  let lookups = 0;
  const history = createSessionNavigationHistory({
    resolve: async () => { lookups += 1; return null; },
    select: () => {},
    isKnownAvailable: () => { availabilityChecks += 1; return false; },
  });
  history.setScope('server-a');
  for (let i = 0; i < 100; i += 1) history.record(visit(String(i)));
  history.refreshAvailability();
  expect(availabilityChecks).toBe(0);
  await history.navigate(-1);
  expect(lookups).toBe(99);
  availabilityChecks = 0;
  const before = history.getSnapshot();
  history.refreshAvailability();
  expect(availabilityChecks).toBe(99);
  expect(lookups).toBe(99);
  expect(history.getSnapshot()).toBe(before);
  history.setScope('server-b');
  availabilityChecks = 0;
  history.refreshAvailability();
  expect(availabilityChecks).toBe(0);
});

test('publishes stable snapshots and releases subscribers', () => {
  const { history } = fixture();
  history.record(visit('A'));
  const snapshot = history.getSnapshot();
  let updates = 0;
  const stop = history.subscribe(() => { updates += 1; });
  history.record(visit('A'));
  expect(history.getSnapshot()).toBe(snapshot);
  expect(updates).toBe(0);
  history.record(visit('B'));
  expect(updates).toBe(1);
  stop();
  history.setBlocked(true);
  expect(updates).toBe(1);
});
