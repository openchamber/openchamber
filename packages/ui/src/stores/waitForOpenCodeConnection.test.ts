import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

let checkHealthImpl: () => Promise<boolean> = async () => true;
const checkHealthCallTimes: number[] = [];
const updateMessages: string[] = [];

mock.module('@/lib/configUpdate', () => ({
  updateConfigUpdateMessage: (message: string) => {
    updateMessages.push(message);
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    checkHealth: () => {
      checkHealthCallTimes.push(Date.now());
      return checkHealthImpl();
    },
  },
}));

const { waitForOpenCodeConnection } = await import('./waitForOpenCodeConnection');

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

type Outcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; error: unknown };

/** Advances the faked clock in steps, flushing the promise chain, until the wait settles. */
const driveToSettlement = async (promise: Promise<void>, stepMs = 100, maxSteps = 400): Promise<Outcome> => {
  let outcome: Outcome | null = null;
  void promise.then(
    () => { outcome = { status: 'fulfilled' }; },
    (error) => { outcome = { status: 'rejected', error }; },
  );
  // Let the first probe run and schedule its sleep at the captured start time,
  // so advancing the clock measures the real poll cadence.
  await flushMicrotasks();
  for (let step = 0; step < maxSteps && outcome === null; step += 1) {
    jest.advanceTimersByTime(stepMs);
    await flushMicrotasks();
  }
  if (outcome === null) {
    throw new Error('waitForOpenCodeConnection did not settle within the drive budget');
  }
  return outcome;
};

const callOffsets = (): number[] => checkHealthCallTimes.map((at) => at - checkHealthCallTimes[0]);

describe('waitForOpenCodeConnection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    checkHealthImpl = async () => true;
    checkHealthCallTimes.length = 0;
    updateMessages.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a healthy probe ends the wait on the first attempt', async () => {
    await waitForOpenCodeConnection();

    expect(checkHealthCallTimes).toHaveLength(1);
    expect(updateMessages).toEqual(['Waiting for OpenCode… (attempt 1)']);
  });

  test('an initial delay is capped at one fast poll interval before the first probe', async () => {
    const promise = waitForOpenCodeConnection(5000);
    await flushMicrotasks();

    expect(checkHealthCallTimes).toHaveLength(0);
    jest.advanceTimersByTime(299);
    await flushMicrotasks();
    expect(checkHealthCallTimes).toHaveLength(0);

    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(checkHealthCallTimes).toHaveLength(1);
    await promise;
  });

  test('unhealthy probes keep polling fast, then back off, until a probe is healthy', async () => {
    let calls = 0;
    checkHealthImpl = async () => {
      calls += 1;
      return calls >= 8;
    };

    const outcome = await driveToSettlement(waitForOpenCodeConnection());

    expect(outcome.status).toBe('fulfilled');
    expect(callOffsets()).toEqual([0, 300, 600, 900, 1200, 2200, 3400, 4800]);
    expect(updateMessages).toEqual([
      'Waiting for OpenCode… (attempt 1)',
      'Waiting for OpenCode… (attempt 2)',
      'Waiting for OpenCode… (attempt 3)',
      'Waiting for OpenCode… (attempt 4)',
      'Waiting for OpenCode… (attempt 5)',
      'Waiting for OpenCode… (attempt 6)',
      'Waiting for OpenCode… (attempt 7)',
      'Waiting for OpenCode… (attempt 8)',
    ]);
  });

  test('an always-unhealthy probe gives up after the bounded maximum with the not-ready error', async () => {
    checkHealthImpl = async () => false;

    const outcome = await driveToSettlement(waitForOpenCodeConnection());

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected a rejection');
    if (!(outcome.error instanceof Error)) throw new Error('expected an Error rejection');
    expect(outcome.error.message).toBe('OpenCode health check reported not ready');
    // Fast attempts (4) then capped backoff (~2s) land on 15 probes before the 20s bound.
    expect(checkHealthCallTimes).toHaveLength(15);
    expect(checkHealthCallTimes[14] - checkHealthCallTimes[0]).toBe(18200);
  });

  test('a probe transport error is retried and rethrown as the last error at timeout', async () => {
    const probeFailure = new Error('health probe transport down');
    checkHealthImpl = async () => {
      throw probeFailure;
    };

    const outcome = await driveToSettlement(waitForOpenCodeConnection());

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected a rejection');
    expect(outcome.error).toBe(probeFailure);
    expect(checkHealthCallTimes).toHaveLength(15);
  });

  test('a non-Error rejection reason is rethrown unchanged', async () => {
    const probeFailure = 'health probe transport down';
    checkHealthImpl = async () => {
      throw probeFailure;
    };

    const outcome = await driveToSettlement(waitForOpenCodeConnection());

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected a rejection');
    expect(outcome.error).toBe(probeFailure);
  });
});
