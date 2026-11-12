import { describe, expect, test } from 'bun:test';

import { reconcileUnknownMutationOutcome } from './sourceControlMutationOutcome';

const unknownOutcomeError = (): Error => Object.assign(new Error('Outcome unknown'), {
  code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN',
});

describe('reconcileUnknownMutationOutcome', () => {
  test('refreshes immediately and schedules a follow-up read', async () => {
    const calls: string[] = [];
    const reconciled = await reconcileUnknownMutationOutcome({
      error: unknownOutcomeError(),
      isCurrent: () => true,
      refresh: async () => { calls.push('refresh'); },
      scheduleRefresh: () => { calls.push('schedule'); },
    });

    expect(reconciled).toBe(true);
    expect(calls).toEqual(['refresh', 'schedule']);
  });

  test('still schedules a follow-up when the immediate read fails', async () => {
    let scheduled = false;
    await reconcileUnknownMutationOutcome({
      error: unknownOutcomeError(),
      isCurrent: () => true,
      refresh: async () => { throw new Error('refresh failed'); },
      scheduleRefresh: () => { scheduled = true; },
    });

    expect(scheduled).toBe(true);
  });

  test('does not reconcile ordinary failures', async () => {
    let refreshed = false;
    const reconciled = await reconcileUnknownMutationOutcome({
      error: new Error('request failed'),
      isCurrent: () => true,
      refresh: async () => { refreshed = true; },
      scheduleRefresh: () => undefined,
    });

    expect(reconciled).toBe(false);
    expect(refreshed).toBe(false);
  });

  test('does not schedule when the mutation scope changes during refresh', async () => {
    let current = true;
    let scheduled = false;
    await reconcileUnknownMutationOutcome({
      error: unknownOutcomeError(),
      isCurrent: () => current,
      refresh: async () => { current = false; },
      scheduleRefresh: () => { scheduled = true; },
    });

    expect(scheduled).toBe(false);
  });
});
