import { describe, expect, test } from 'bun:test';

const {
  dropQueued,
  isAgentControlling,
  noteUserAction,
  runMutatingOperation,
  subscribeAgentControl,
} = await import('./controlCoordinator');

const USER_CONFLICT = 'The user interacted with this tab while the action ran; retry the action';

const keyA = 'runtime\n/proj\ntab-a';
const keyB = 'runtime\n/proj\ntab-b';

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Settles a promise into a plain value so assertion matchers stay bun-typable. */
const outcome = <T>(promise: Promise<T>): Promise<{ result?: T; error?: unknown }> => (
  promise.then((result) => ({ result }), (error: unknown) => ({ error }))
);

describe('serializing mutating operations per key', () => {
  test('two concurrent mutating ops on one tab serialize and never overlap', async () => {
    const gate = deferred<string>();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const first = runMutatingOperation(keyA, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('start-1');
      const value = await gate.promise;
      active -= 1;
      order.push('end-1');
      return value;
    });
    const second = runMutatingOperation(keyA, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('start-2');
      active -= 1;
      order.push('end-2');
      return 'two';
    });

    gate.resolve('one');
    const [one, two] = await Promise.all([first, second]);

    expect(one).toBe('one');
    expect(two).toBe('two');
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(maxActive).toBe(1);
  });

  test('ops on different tabs run in parallel', async () => {
    const gate = deferred<string>();
    const started: string[] = [];

    const onA = runMutatingOperation(keyA, async () => {
      started.push('a');
      return gate.promise;
    });
    const onB = runMutatingOperation(keyB, async () => {
      started.push('b');
      return 'b-done';
    });

    // B started while A is still blocked: no cross-tab serialization.
    expect(started).toEqual(['a', 'b']);

    gate.resolve('a-done');
    const [a, b] = await Promise.all([onA, onB]);
    expect(a).toBe('a-done');
    expect(b).toBe('b-done');
  });

  test('a mutating op whose fn rejects propagates AND releases the queue', async () => {
    const boom = new Error('boom');
    const order: string[] = [];

    const failing = runMutatingOperation(keyA, async () => {
      order.push('failing');
      throw boom;
    });
    const queued = runMutatingOperation(keyA, async () => {
      order.push('queued');
      return 'after';
    });

    const failed = await outcome(failing);
    expect(failed.error).toBe(boom);
    expect(await queued).toBe('after');
    expect(order).toEqual(['failing', 'queued']);
  });
});

describe('invalidating in-flight operations on user input', () => {
  test('a user chrome action mid-op makes the in-flight op surface the conflict error', async () => {
    const gate = deferred<string>();
    const pending = runMutatingOperation(keyA, () => gate.promise);

    noteUserAction(keyA);
    gate.resolve('agent-result');

    const settled = await outcome(pending);
    expect(settled.result).toBe(undefined);
    expect(settled.error instanceof Error).toBe(true);
    expect((settled.error as Error).message).toBe(USER_CONFLICT);
  });

  test('typing in the address bar (no submit) during an in-flight agent navigation invalidates it', async () => {
    // The pane wires address-input onChange to noteUserAction: a keystroke
    // alone — no navigation ever submitted — must discard the agent's result.
    const gate = deferred<string>();
    const pending = runMutatingOperation(keyA, () => gate.promise);

    noteUserAction(keyA);
    gate.resolve('navigated');

    const settled = await outcome(pending);
    expect((settled.error as Error).message).toBe(USER_CONFLICT);
  });

  test('a user action after settle does NOT retroactively error', async () => {
    const settled = await runMutatingOperation(keyA, async () => 'done');
    noteUserAction(keyA);
    expect(settled).toBe('done');

    // The next op records the newer generation at its start and runs clean.
    const next = await runMutatingOperation(keyA, async () => 'next');
    expect(next).toBe('next');
  });

  test('a user action during a QUEUED (not started) op does not error it — it runs with the newer generation', async () => {
    const gate = deferred<string>();
    const inflight = runMutatingOperation(keyA, () => gate.promise);
    const queued = runMutatingOperation(keyA, async () => 'queued-result');

    // The queued op has not started, so the bump only invalidates the op
    // that was running through it.
    noteUserAction(keyA);
    gate.resolve('one');

    const inflightSettled = await outcome(inflight);
    expect((inflightSettled.error as Error).message).toBe(USER_CONFLICT);
    expect(await queued).toBe('queued-result');
  });
});

describe('dropQueued', () => {
  test('removes a queued op (it never runs), clears controlling state, and discards the in-flight result', async () => {
    const gate = deferred<string>();
    const inflight = runMutatingOperation(keyA, () => gate.promise);
    let ranQueued = false;
    const queued = runMutatingOperation(keyA, async () => {
      ranQueued = true;
      return 'queued';
    });

    expect(isAgentControlling(keyA)).toBe(true);
    dropQueued(keyA);
    expect(isAgentControlling(keyA)).toBe(false);

    // The in-flight op cannot be killed; it finishes and its caller discards
    // the result through the same conflict mechanism.
    gate.resolve('late');
    const inflightSettled = await outcome(inflight);
    expect((inflightSettled.error as Error).message).toBe(USER_CONFLICT);

    const queuedSettled = await outcome(queued);
    expect(ranQueued).toBe(false);
    expect(queuedSettled.error instanceof Error).toBe(true);
  });

  test('is a no-op on an empty queue, not a throw', () => {
    const empty = 'runtime\n/proj\ntab-never-touched';
    dropQueued(empty);
    dropQueued(keyA);
    expect(isAgentControlling(empty)).toBe(false);
    expect(isAgentControlling(keyA)).toBe(false);
  });
});

describe('agent-controlling state and subscription', () => {
  test('reports controlling while an op runs and notifies subscribers on transitions', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeAgentControl(() => seen.push(isAgentControlling(keyA)));

    expect(isAgentControlling(keyA)).toBe(false);
    const gate = deferred<string>();
    const pending = runMutatingOperation(keyA, () => gate.promise);
    expect(isAgentControlling(keyA)).toBe(true);

    gate.resolve('x');
    await pending;
    expect(isAgentControlling(keyA)).toBe(false);
    expect(seen).toEqual([true, false]);
    unsubscribe();
  });

  test('stays controlling while a queued op is still waiting behind a settling one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const one = runMutatingOperation(keyA, () => first.promise);
    const two = runMutatingOperation(keyA, () => second.promise);

    first.resolve('one');
    await one;
    // The second op holds the key even though the first has fully settled.
    expect(isAgentControlling(keyA)).toBe(true);

    second.resolve('two');
    await two;
    expect(isAgentControlling(keyA)).toBe(false);
  });
});
