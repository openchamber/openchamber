import { beforeEach, describe, expect, test } from 'bun:test';
import {
  applyPrWatch,
  applyPrWatchSnapshot,
  resetPrWatchesForRuntimeSwitch,
  restorePrWatch,
  takePrWatch,
  usePrWatchStore,
  type PrWatch,
} from './pr-watch';

const watch = (sessionID: string, extra: Partial<PrWatch> = {}): PrWatch => ({
  sessionID, directory: '/repo', url: 'https://github.com/acme/app/pull/7', number: 7, title: 'Fix', status: 'pending', startedAt: 1, ...extra,
});

const statusOf = (sessionID: string) => usePrWatchStore.getState().bySession.get(sessionID)?.status ?? null;

describe('pull request watch projection', () => {
  beforeEach(() => resetPrWatchesForRuntimeSwitch());

  test('an older update never undoes a newer one, from an event or a snapshot', () => {
    applyPrWatch(5, 'ses_a', watch('ses_a', { status: 'passed' }));
    applyPrWatch(4, 'ses_a', watch('ses_a', { status: 'pending' }));
    expect(statusOf('ses_a')).toBe('passed');

    applyPrWatchSnapshot({ revision: 3, watches: [] });
    expect(statusOf('ses_a')).toBe('passed');

    applyPrWatchSnapshot({ revision: 6, watches: [watch('ses_b')] });
    expect(statusOf('ses_a')).toBeNull();
    expect(statusOf('ses_b')).toBe('pending');

    applyPrWatch(7, 'ses_b', null);
    expect(usePrWatchStore.getState().bySession.size).toBe(0);
  });

  test('a stop the server refused puts the row back', () => {
    applyPrWatch(1, 'ses_a', watch('ses_a'));
    const taken = takePrWatch('ses_a');
    expect(statusOf('ses_a')).toBeNull();
    restorePrWatch(taken!);
    expect(statusOf('ses_a')).toBe('pending');
  });

  test('a failed stop does not bring back a watch the server already removed', () => {
    applyPrWatch(1, 'ses_a', watch('ses_a'));
    const taken = takePrWatch('ses_a');
    // The removal arrived; the response to the stop did not.
    applyPrWatch(2, 'ses_a', null);
    restorePrWatch(taken!);
    expect(statusOf('ses_a')).toBeNull();

    applyPrWatch(3, 'ses_b', watch('ses_b'));
    const other = takePrWatch('ses_b');
    resetPrWatchesForRuntimeSwitch();
    restorePrWatch(other!);
    expect(statusOf('ses_b')).toBeNull();
  });
});
