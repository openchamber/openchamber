import { beforeEach, describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import {
  flushSessionActivityTimestamps,
  readRecordedEntrySpan,
  recordSessionTimestampEvents,
  recordSessionTimestampsFromHistory,
  resetSessionActivityTimestamps,
  resolveSessionTimestamps,
  sortSessionScopesByTimestamp,
  useSessionActivityTimestampsStore,
} from './session-activity-timestamps';

const session = (id: string, created: number, extra: Partial<Session> = {}): Session => ({
  id,
  projectID: 'p',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, updated: created },
  ...extra,
});

const stamps = (id: string) => useSessionActivityTimestampsStore.getState().byId.get(id);

beforeEach(() => {
  getSafeStorage().clear();
  resetSessionActivityTimestamps({ reload: false });
});

describe('session activity timestamps', () => {
  // Oracle: the event times OpenCode sent, field by field.
  test('input, completed output, thinking and shell activity update their own fields', () => {
    recordSessionTimestampEvents([
      { type: 'message.updated', at: 10, properties: { info: { id: 'u', sessionID: 's', role: 'user', time: { created: 10 } } } },
      { type: 'message.part.updated', at: 20, properties: { sessionID: 's', part: { id: 'r', sessionID: 's', messageID: 'a', type: 'reasoning', text: '', time: { start: 20 }, displayTime: { start: 20 } } } },
      { type: 'message.patched', at: 30, properties: { sessionID: 's', messageID: 'a', patch: { finish: 'stop', time: { completed: 30 } } } },
      { type: 'shell.started', at: 40, properties: { shell: { id: 'sh', sessionID: 's', command: 'ls', file: '/tmp/x', startedAt: 40 } } },
      { type: 'shell.ended', at: 50, properties: { shellID: 'sh', end: { kind: 'exited', status: 'exited', exit: 0 }, endedAt: 50 } },
    ], 999);
    expect(stamps('s')).toEqual({ input: 10, output: 30, activity: 50 });
    expect(readRecordedEntrySpan(useSessionActivityTimestampsStore.getState(), 's', 'r')).toEqual({ start: 20, end: undefined });
  });

  test('a failed step and a shell completion never count as completed output', () => {
    recordSessionTimestampEvents([
      { type: 'message.patched', at: 30, properties: { sessionID: 's', messageID: 'a', patch: { finish: 'error', time: { completed: 30 } } } },
      { type: 'message.patched', at: 40, properties: { sessionID: 's', messageID: 'sh', patch: { shell: { status: 'exited' }, time: { completed: 40 } } } },
    ]);
    expect(stamps('s')?.output).toBeUndefined();
    expect(stamps('s')?.activity).toBe(40);
  });

  test('replayed events keep their server time rather than the receipt time', () => {
    recordSessionTimestampEvents([{ type: 'message.part.delta', at: 5, properties: { sessionID: 's', messageID: 'a', partID: 'p', field: 'text', delta: 'x' } }], 1_000_000);
    expect(stamps('s')?.activity).toBe(5);
  });

  test('history without exact text times records no entry span', () => {
    recordSessionTimestampsFromHistory('s', [{
      info: { id: 'a', sessionID: 's', role: 'assistant', time: { created: 1, completed: 9 }, agent: 'b', providerID: 'p', modelID: 'm', finish: 'stop' },
      parts: [{ id: 't', sessionID: 's', messageID: 'a', type: 'text', text: 'hi', time: { start: 1, end: 9 }, displayTime: {} }],
    }]);
    expect(stamps('s')).toEqual({ input: undefined, output: 9, activity: 9 });
    expect(readRecordedEntrySpan(useSessionActivityTimestampsStore.getState(), 's', 't')).toBeUndefined();
  });

  test('recorded times survive a reload and deletion removes them', () => {
    recordSessionTimestampEvents([{ type: 'message.updated', at: 7, properties: { info: { id: 'u', sessionID: 's', role: 'user', time: { created: 7 } } } }]);
    flushSessionActivityTimestamps();
    resetSessionActivityTimestamps({ reload: true });
    expect(stamps('s')?.input).toBe(7);
    recordSessionTimestampEvents([{ type: 'session.deleted', properties: { sessionID: 's' } }]);
    flushSessionActivityTimestamps();
    resetSessionActivityTimestamps({ reload: true });
    expect(stamps('s')).toBeUndefined();
  });

  test('missing history is unavailable, never guessed from idle', () => {
    expect(resolveSessionTimestamps(session('s', 1, { time: { created: 1, updated: 3, idle: 2 } }), undefined))
      .toEqual({ created: 1, input: null, output: null, activity: 2 });
  });
});

describe('sortSessionScopesByTimestamp', () => {
  // Oracle: invariants. Known values are monotonic in the chosen direction,
  // unavailable values come last in both directions, and subsessions follow their parent.
  test('orders known values and puts unavailable ones last', () => {
    // Reproducible generated cases without adding a dependency to this checkout.
    let seed = 917;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let run = 0; run < 1000; run += 1) {
      const sessions = Array.from({ length: 2 + next() % 28 }, (_, index) => session(`s${index}`, 1 + next() % 1000));
      const recorded = new Map(sessions.flatMap((item, index) => index > 0 && next() % 3 === 0 ? [] : [[item.id, { input: next() % 1000, output: next() % 1000, activity: next() % 1000 }] as const]));
      for (const field of ['created', 'input', 'output', 'activity'] as const) for (const direction of ['asc', 'desc'] as const) {
        const sorted = sortSessionScopesByTimestamp(sessions, field, direction, recorded, () => false);
        const values = sorted.map((item) => resolveSessionTimestamps(item, recorded.get(item.id))[field]);
        const firstMissing = values.indexOf(null);
        if (firstMissing !== -1) expect(values.slice(firstMissing).every((value) => value === null)).toBe(true);
        const known = values.filter((value): value is number => value !== null);
        for (let index = 1; index < known.length; index += 1) {
          expect(direction === 'asc' ? known[index - 1] <= known[index] : known[index - 1] >= known[index]).toBe(true);
        }
      }
    }
  });

  test('keeps pins first and children after their parent', () => {
    const parent = session('parent', 1);
    const child = session('child', 99, { parentID: 'parent' });
    const newer = session('newer', 50);
    const pinned = session('pinned', 0);
    expect(sortSessionScopesByTimestamp([child, parent, newer, pinned], 'created', 'desc', new Map(), (item) => item.id === 'pinned')
      .map((item) => item.id)).toEqual(['pinned', 'newer', 'parent', 'child']);
  });
});
