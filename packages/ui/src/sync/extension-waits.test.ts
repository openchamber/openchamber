import { beforeEach, describe, expect, test } from 'bun:test';
import {
  applyExtensionWaits,
  applyExtensionWaitsSnapshot,
  resetExtensionWaitsForRuntimeSwitch,
  restoreExtensionWaits,
  takeExtensionWaits,
  useExtensionWaitsStore,
  type ExtensionWait,
} from './extension-waits';

const wait = (sessionID: string, extra: Partial<ExtensionWait> = {}): ExtensionWait => ({
  waitId: `wait_${sessionID}`, sessionID, directory: '/repo', source: 'wait-kit/timer', extension: 'Wait Kit',
  title: 'Timer', label: '10 s', startedAt: 1, status: 'waiting', ...extra,
});

const statusesOf = (sessionID: string) => useExtensionWaitsStore.getState().bySession.get(sessionID)?.map((entry) => entry.status) ?? null;

describe('extension wait projection', () => {
  beforeEach(() => resetExtensionWaitsForRuntimeSwitch());

  test('an older update never undoes a newer one, from an event or a snapshot', () => {
    applyExtensionWaits(5, 'ses_a', [wait('ses_a', { status: 'waking' })]);
    applyExtensionWaits(4, 'ses_a', [wait('ses_a')]);
    expect(statusesOf('ses_a')).toEqual(['waking']);

    applyExtensionWaitsSnapshot({ revision: 3, waits: [] });
    expect(statusesOf('ses_a')).toEqual(['waking']);

    // A snapshot groups a session's waits, oldest first, as the server lists them.
    applyExtensionWaitsSnapshot({ revision: 6, waits: [wait('ses_b'), wait('ses_b', { waitId: 'wait_2', status: 'waking' })] });
    expect(statusesOf('ses_a')).toBeNull();
    expect(statusesOf('ses_b')).toEqual(['waiting', 'waking']);

    applyExtensionWaits(7, 'ses_b', []);
    expect(useExtensionWaitsStore.getState().bySession.size).toBe(0);
  });

  test('a stop the server refused puts the row back, unless the server said something newer', () => {
    applyExtensionWaits(1, 'ses_a', [wait('ses_a')]);
    const taken = takeExtensionWaits('ses_a');
    expect(statusesOf('ses_a')).toBeNull();
    restoreExtensionWaits(taken!);
    expect(statusesOf('ses_a')).toEqual(['waiting']);

    const again = takeExtensionWaits('ses_a');
    // The removal arrived; the response to the stop did not.
    applyExtensionWaits(2, 'ses_a', []);
    restoreExtensionWaits(again!);
    expect(statusesOf('ses_a')).toBeNull();

    applyExtensionWaits(3, 'ses_b', [wait('ses_b')]);
    const other = takeExtensionWaits('ses_b');
    resetExtensionWaitsForRuntimeSwitch();
    restoreExtensionWaits(other!);
    expect(statusesOf('ses_b')).toBeNull();
  });
});
