import { beforeEach, describe, expect, test } from 'bun:test';
import {
  applyPrWatches,
  applyPrWatchSnapshot,
  resetPrWatchesForRuntimeSwitch,
  restorePrWatches,
  takePrWatches,
  usePrWatchStore,
  type PrWatch,
} from './pr-watch';

const watch = (sessionID: string, extra: Partial<PrWatch> = {}): PrWatch => ({
  sessionID, directory: '/repo', url: 'https://github.com/acme/app/pull/7', number: 7, title: 'Fix', status: 'pending', startedAt: 1, ...extra,
});
const watch8 = (sessionID: string): PrWatch => watch(sessionID, { url: 'https://github.com/acme/app/pull/8', number: 8, startedAt: 2 });

const statusOf = (sessionID: string) => usePrWatchStore.getState().bySession.get(sessionID)?.[0]?.status ?? null;
const numbersOf = (sessionID: string) => usePrWatchStore.getState().bySession.get(sessionID)?.map((entry) => entry.number) ?? [];

describe('pull request watch projection', () => {
  beforeEach(() => resetPrWatchesForRuntimeSwitch());

  test('an older update never undoes a newer one, from an event or a snapshot', () => {
    applyPrWatches(5, 'ses_a', [watch('ses_a', { status: 'passed' })]);
    applyPrWatches(4, 'ses_a', [watch('ses_a', { status: 'pending' })]);
    expect(statusOf('ses_a')).toBe('passed');

    applyPrWatchSnapshot({ revision: 3, watches: [] });
    expect(statusOf('ses_a')).toBe('passed');

    applyPrWatchSnapshot({ revision: 6, watches: [watch('ses_b')] });
    expect(statusOf('ses_a')).toBeNull();
    expect(statusOf('ses_b')).toBe('pending');

    applyPrWatches(7, 'ses_b', []);
    expect(usePrWatchStore.getState().bySession.size).toBe(0);
  });

  test('a session keeps every pull request it waits on, from an event or a snapshot', () => {
    applyPrWatchSnapshot({ revision: 1, watches: [watch('ses_a'), watch8('ses_a'), watch('ses_b')] });
    expect(numbersOf('ses_a')).toEqual([7, 8]);
    expect(numbersOf('ses_b')).toEqual([7]);

    applyPrWatches(2, 'ses_a', [watch8('ses_a')]);
    expect(numbersOf('ses_a')).toEqual([8]);
  });

  test('a stop the server refused puts the row back', () => {
    applyPrWatches(1, 'ses_a', [watch('ses_a')]);
    const taken = takePrWatches('ses_a');
    expect(statusOf('ses_a')).toBeNull();
    restorePrWatches(taken!);
    expect(statusOf('ses_a')).toBe('pending');
  });

  test('stopping one pull request leaves the others, and a refusal puts it back in its place', () => {
    applyPrWatches(1, 'ses_a', [watch('ses_a'), watch8('ses_a')]);
    const seven = takePrWatches('ses_a', watch('ses_a').url);
    const eight = takePrWatches('ses_a', watch8('ses_a').url);
    expect(numbersOf('ses_a')).toEqual([]);

    restorePrWatches(eight!);
    restorePrWatches(seven!);
    expect(numbersOf('ses_a')).toEqual([7, 8]);
  });

  test('a failed stop does not bring back a watch the server already removed', () => {
    applyPrWatches(1, 'ses_a', [watch('ses_a')]);
    const taken = takePrWatches('ses_a');
    // The removal arrived; the response to the stop did not.
    applyPrWatches(2, 'ses_a', []);
    restorePrWatches(taken!);
    expect(statusOf('ses_a')).toBeNull();

    applyPrWatches(3, 'ses_b', [watch('ses_b')]);
    const other = takePrWatches('ses_b');
    resetPrWatchesForRuntimeSwitch();
    restorePrWatches(other!);
    expect(statusOf('ses_b')).toBeNull();
  });
});
