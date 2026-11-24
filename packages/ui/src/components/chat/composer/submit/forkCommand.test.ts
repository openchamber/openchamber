import { expect, jest, spyOn, test } from 'bun:test';
import { OPENCODE_REQUEST_TIMEOUT_MS, opencodeClient } from '@/lib/opencode/client';
import { commitModelPick, whenModelPickWritten } from '@/sync/model-gesture';
import { useSelectionStore } from '@/sync/selection-store';
import type { Session } from '@/lib/opencode/model';
import { runForkCommand } from './forkCommand';

const selection = { providerID: 'anthropic', modelID: 'opus', variant: 'high' };
// SAFETY: runForkCommand reads only the fork's id from the session.
const forked = { id: 'ses_fork' } as Session;

test('/fork <text> forks only after this client\'s fresh model pick on the parent has been written', async () => {
  const events: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const switchModel = spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => {
    events.push('write started');
    await held;
    events.push('write done');
  });
  try {
    commitModelPick('ses_parent', { providerID: 'anthropic', modelID: 'opus', variant: 'high' }, '/work');
    const running = runForkCommand('ses_parent', 'Question', selection, {
      fork: async () => { events.push('fork'); return forked; },
      directoryFor: () => '/work',
      send: async () => { events.push('send'); },
      draftIdentity: () => null,
      restoreText: () => {},
    });
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    expect(events).toEqual(['write started']);
    release();
    expect(await running).toBe('sent');
    expect(events).toEqual(['write started', 'write done', 'fork', 'send']);
  } finally {
    release();
    await whenModelPickWritten('ses_parent');
    switchModel.mockRestore();
    useSelectionStore.getState().clearSessionSelections('ses_parent');
  }
});

test('/fork <text> forks at once when no model pick is in flight', async () => {
  const events: string[] = [];
  expect(await runForkCommand('ses_idle', 'Question', selection, {
    fork: async () => { events.push('fork'); return forked; },
    directoryFor: () => '/work',
    send: async () => { events.push('send'); },
    draftIdentity: () => null,
    restoreText: () => {},
  })).toBe('sent');
  expect(events).toEqual(['fork', 'send']);
});

test('/fork <text> gives up on a model pick that never settles: no fork, the failure is raised and the text can come back', async () => {
  jest.useFakeTimers();
  const events: string[] = [];
  const switchModel = spyOn(opencodeClient, 'switchSessionModel').mockImplementation(() => new Promise<void>(() => {}));
  try {
    commitModelPick('ses_stuck', { providerID: 'anthropic', modelID: 'opus', variant: 'high' }, '/work');
    const outcome = runForkCommand('ses_stuck', 'Question', selection, {
      fork: async () => { events.push('fork'); return forked; },
      directoryFor: () => '/work',
      send: async () => { events.push('send'); },
      draftIdentity: () => null,
      restoreText: () => {},
    }).then(() => null, (error: Error) => error);
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    jest.advanceTimersByTime(OPENCODE_REQUEST_TIMEOUT_MS - 1);
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    expect(events).toEqual([]);
    jest.advanceTimersByTime(1);
    expect((await outcome)?.message).toBe('Could not switch the model');
    expect(events).toEqual([]);
  } finally {
    jest.useRealTimers();
    switchModel.mockRestore();
    useSelectionStore.getState().clearSessionSelections('ses_stuck');
  }
});
