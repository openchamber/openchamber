import { describe, expect, test } from 'bun:test';
import type { Message } from '@/lib/opencode/model';
import { readLastMessageState, scheduleUnansweredRechecks } from './sessionErrorNoticeState';

// A user message never finishes a turn, so a stray `completed` on one — older
// optimistic sends stamped `completed: 0` — must be ignored.
const optimisticUserMessage = {
  id: 'msg_1',
  sessionID: 'ses_1',
  role: 'user',
  time: { created: 1_000, completed: 0 },
} as Message;

const assistantMessage = (time: { created: number; completed?: number }): Message => ({
  id: 'msg_2',
  sessionID: 'ses_1',
  role: 'assistant',
  modelID: 'model',
  providerID: 'provider',
  agent: 'build',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time,
});

describe('readLastMessageState', () => {
  test('a stray completed: 0 on a user message is ignored in favour of created', () => {
    expect(readLastMessageState(optimisticUserMessage)).toEqual({ role: 'user', timestamp: 1_000, hasError: false });
  });

  test('an unfinished assistant message uses created, a finished one uses completed', () => {
    expect(readLastMessageState(assistantMessage({ created: 1_000 }))?.timestamp).toBe(1_000);
    expect(readLastMessageState(assistantMessage({ created: 1_000, completed: 2_000 }))?.timestamp).toBe(2_000);
  });

  test('no message yields no state', () => {
    expect(readLastMessageState(null)).toBeNull();
  });
});

describe('scheduleUnansweredRechecks', () => {
  const fakeScheduler = () => {
    const timers = new Map<number, { callback: () => void; ms: number }>();
    let next = 1;
    return {
      timers,
      setTimeout: (callback: () => void, ms: number) => {
        const handle = next++;
        timers.set(handle, { callback, ms });
        return handle;
      },
      clearTimeout: (handle: number) => {
        timers.delete(handle);
      },
      fire: () => {
        for (const { callback } of [...timers.values()].sort((a, b) => a.ms - b.ms)) callback();
      },
    };
  };

  test('re-reads the session once per offset so a missed reply replaces the notice', () => {
    const scheduler = fakeScheduler();
    let reads = 0;
    scheduleUnansweredRechecks(async () => { reads += 1; }, scheduler, undefined, [0, 10, 30]);
    expect([...scheduler.timers.values()].map((timer) => timer.ms)).toEqual([0, 10, 30]);
    scheduler.fire();
    expect(reads).toBe(3);
  });

  test('stops reading once the notice is gone', () => {
    const scheduler = fakeScheduler();
    let reads = 0;
    const cancel = scheduleUnansweredRechecks(async () => { reads += 1; }, scheduler, undefined, [0, 10]);
    const pending = [...scheduler.timers.values()];
    cancel();
    expect(scheduler.timers.size).toBe(0);
    for (const { callback } of pending) callback();
    expect(reads).toBe(0);
  });

  test('reports each read as settled, whether it found anything or failed', async () => {
    const scheduler = fakeScheduler();
    let settled = 0;
    let call = 0;
    scheduleUnansweredRechecks(
      () => (call++ === 0 ? Promise.resolve() : Promise.reject(new Error('offline'))),
      scheduler,
      () => { settled += 1; },
      [0, 10],
    );
    expect(settled).toBe(0);
    scheduler.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(2);
  });

  test('a read that settles after cancellation reports nothing', async () => {
    const scheduler = fakeScheduler();
    let settled = 0;
    let resolveRead: () => void = () => undefined;
    const cancel = scheduleUnansweredRechecks(
      () => new Promise<void>((resolve) => { resolveRead = resolve; }),
      scheduler,
      () => { settled += 1; },
      [0],
    );
    scheduler.fire();
    cancel();
    resolveRead();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(0);
  });
});
