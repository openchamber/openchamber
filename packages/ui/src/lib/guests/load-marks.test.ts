import { beforeEach, describe, expect, test } from 'bun:test';

import { createGuestMarksLoader } from './load-marks.ts';
import { EMPTY_GUEST_MARK_INDEX, type GuestMarkEntry } from './marks.ts';
import { useGuestMarksStore } from './marks-store.ts';
import type { InstalledGuest } from './types.ts';

const ci: InstalledGuest = {
  id: 'ci',
  name: 'CI',
  icon: 'window',
  source: 'path',
  marks: true,
  capabilities: { requested: ['service', 'marks'], granted: ['service', 'marks'] },
};

const marks = (...texts: string[]): GuestMarkEntry[] => texts.map((text, index) => ({
  guestId: 'ci',
  target: { sessionId: `ses_${index + 1}` },
  mark: { icon: 'check', tone: 'success', text },
}));

const shownTexts = (): string[] => [...useGuestMarksStore.getState().bySession.values()].flat().map((mark) => mark.text);

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

/** A loader whose reads answer when the test says and whose timers run when the test fires them. */
const setup = () => {
  const unanswered: Array<(entries: GuestMarkEntry[] | null) => void> = [];
  let reads = 0;
  const timers: Array<{ run: () => void; delayMs: number }> = [];
  const runtime = { key: 'server-a', supported: true };
  const loader = createGuestMarksLoader({
    read: () => new Promise((resolve) => {
      reads += 1;
      unanswered.push(resolve);
    }),
    runtimeKey: () => runtime.key,
    supported: () => runtime.supported,
    later: (run, delayMs) => {
      const timer = { run, delayMs };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at !== -1) timers.splice(at, 1);
      };
    },
  });
  return {
    loader,
    runtime,
    reads: () => reads,
    waiting: () => timers.map((timer) => timer.delayMs),
    /** Answers the oldest read still out. */
    answer: async (entries: GuestMarkEntry[] | null): Promise<void> => {
      const resolve = unanswered.shift();
      if (!resolve) throw new Error('Expected a read to answer');
      resolve(entries);
      await settle();
    },
    /** Runs the one waiting timer, or the one with this delay. */
    fire: async (delayMs?: number): Promise<void> => {
      const at = delayMs === undefined ? 0 : timers.findIndex((timer) => timer.delayMs === delayMs);
      const [timer] = at === -1 ? [] : timers.splice(at, 1);
      if (!timer) throw new Error('Expected a timer to fire');
      timer.run();
      await settle();
    },
  };
};

beforeEach(() => {
  useGuestMarksStore.setState({ ...EMPTY_GUEST_MARK_INDEX, runtimeKey: '', entries: [], guests: [ci], places: [] });
});

describe('createGuestMarksLoader', () => {
  test('a read shows what the server lists', async () => {
    const { loader, answer } = setup();
    const done = loader.reload();
    await settle();
    await answer(marks('Checks passed'));
    await done;
    expect(useGuestMarksStore.getState().runtimeKey).toBe('server-a');
    expect(shownTexts()).toEqual(['Checks passed']);
  });

  test('a failed read keeps what was shown and is tried again three times, further apart each time', async () => {
    const { loader, answer, fire, reads, waiting } = setup();
    void loader.reload();
    await settle();
    await answer(marks('Checks passed'));

    void loader.reload();
    await settle();
    for (const delayMs of [1_000, 5_000, 20_000]) {
      await answer(null);
      expect(shownTexts()).toEqual(['Checks passed']);
      expect(waiting()).toEqual([delayMs]);
      await fire();
    }
    await answer(null);
    expect(waiting()).toEqual([]);
    expect(reads()).toBe(5);
    expect(shownTexts()).toEqual(['Checks passed']);
  });

  test('a retry that answers shows the marks and ends the retries', async () => {
    const { loader, answer, fire, waiting } = setup();
    void loader.reload();
    await settle();
    await answer(null);
    await fire();
    await answer(marks('Checks passed'));
    expect(shownTexts()).toEqual(['Checks passed']);
    expect(waiting()).toEqual([]);

    // The count starts over for the next outage.
    void loader.reload();
    await settle();
    await answer(null);
    expect(waiting()).toEqual([1_000]);
  });

  test('changes announced during a read give one more read, after a pause', async () => {
    const { loader, answer, fire, reads, waiting } = setup();
    const first = loader.reload();
    await settle();
    const burst = [loader.reload(), loader.reload(), loader.reload()];
    expect(new Set(burst)).toEqual(new Set([first]));
    expect(reads()).toBe(1);

    await answer(marks('Before the burst'));
    expect(shownTexts()).toEqual(['Before the burst']);
    expect(reads()).toBe(1);
    expect(waiting()).toEqual([100]);

    // What arrives during the pause shares the read that follows it.
    void loader.reload();
    await fire();
    expect(reads()).toBe(2);
    await answer(marks('After', 'the burst'));
    await first;
    expect(shownTexts()).toEqual(['After', 'the burst']);
    expect(reads()).toBe(2);
    expect(waiting()).toEqual([]);
  });

  test('a change announced during the follow-up read is read once more', async () => {
    const { loader, answer, fire, reads } = setup();
    const done = loader.reload();
    await settle();
    void loader.reload();
    await answer(marks('One'));
    await fire();
    void loader.reload();
    await answer(marks('Two'));
    await fire();
    await answer(marks('Three'));
    await done;
    expect(reads()).toBe(3);
    expect(shownTexts()).toEqual(['Three']);
  });

  test('changes announced while the server is away do not use up the retries', async () => {
    const { loader, answer, fire, reads, waiting } = setup();
    void loader.reload();
    await settle();
    for (let change = 0; change < 5; change += 1) void loader.reload();
    await answer(null);
    // The read for the burst waits for its pause next to the first retry.
    expect(waiting()).toEqual([1_000, 100]);
    await fire(100);
    expect(waiting()).toEqual([]);
    await answer(null);
    expect(reads()).toBe(2);

    for (const delayMs of [1_000, 5_000, 20_000]) {
      expect(waiting()).toEqual([delayMs]);
      await fire();
      await answer(null);
    }
    expect(waiting()).toEqual([]);
  });

  test('a server switch during the pause ends the reads for the server the app left', async () => {
    const { loader, runtime, answer, fire, reads } = setup();
    const done = loader.reload();
    await settle();
    void loader.reload();
    await answer(marks('On server A'));
    runtime.key = 'server-b';
    await fire(100);
    await done;
    expect(reads()).toBe(1);
  });

  test('stop ends a waiting retry', async () => {
    const { loader, answer, reads, waiting } = setup();
    void loader.reload();
    await settle();
    await answer(null);
    expect(waiting()).toEqual([1_000]);
    loader.stop();
    expect(waiting()).toEqual([]);
    expect(reads()).toBe(1);
  });

  test('a change announced while a retry waits is read at once and replaces the retry', async () => {
    const { loader, answer, reads, waiting } = setup();
    void loader.reload();
    await settle();
    await answer(null);
    void loader.reload();
    await settle();
    expect(reads()).toBe(2);
    expect(waiting()).toEqual([]);
    await answer(marks('Back'));
    expect(shownTexts()).toEqual(['Back']);
  });

  test('the answer of a server the app left is dropped, whether it lists marks or fails', async () => {
    for (const late of [marks('Late from server A'), null]) {
      useGuestMarksStore.setState({ ...EMPTY_GUEST_MARK_INDEX, runtimeKey: '', entries: [] });
      const { loader, runtime, answer, reads, waiting } = setup();
      void loader.reload();
      await settle();
      await answer(marks('On server A'));

      const stale = loader.reload();
      await settle();
      runtime.key = 'server-b';
      const fresh = loader.reload();
      await settle();
      expect(fresh).not.toBe(stale);
      expect(useGuestMarksStore.getState().runtimeKey).toBe('server-b');
      expect(shownTexts()).toEqual([]);
      expect(reads()).toBe(3);

      await answer(late);
      await stale;
      expect(shownTexts()).toEqual([]);
      expect(waiting()).toEqual([]);

      await answer(marks('On server B'));
      await fresh;
      expect(shownTexts()).toEqual(['On server B']);
    }
  });

  test('a retry left from the server the app left reads nothing', async () => {
    const { loader, runtime, answer, fire, reads } = setup();
    void loader.reload();
    await settle();
    await answer(null);
    runtime.key = 'server-b';
    await fire();
    expect(reads()).toBe(1);
  });

  test('a runtime that loads no extensions is never asked', async () => {
    const { loader, runtime, reads, waiting } = setup();
    runtime.supported = false;
    await loader.reload();
    expect(reads()).toBe(0);
    expect(waiting()).toEqual([]);
    expect(shownTexts()).toEqual([]);
  });
});
