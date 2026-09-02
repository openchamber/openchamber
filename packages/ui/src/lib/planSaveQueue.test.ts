import { describe, expect, test } from 'bun:test';

import { createPlanSaveQueue } from './planSaveQueue';

type Deferred = { promise: Promise<void>; resolve: () => void; reject: () => void };

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('planSaveQueue', () => {
  test('runs writes for one document in schedule order even when they resolve out of order', async () => {
    const queue = createPlanSaveQueue();
    const order: string[] = [];
    const first = deferred();
    const second = deferred();

    const firstDone = queue.schedule('doc', 1, async () => {
      await first.promise;
      order.push('first');
    });
    const secondDone = queue.schedule('doc', 2, async () => {
      order.push('second');
    });

    // Second started only after first settles, regardless of timing.
    first.resolve();
    await firstDone;
    second.resolve();
    await secondDone;

    expect(order).toEqual(['first', 'second']);
  });

  test('skips a revision at or below the last queued revision for the same document', async () => {
    const queue = createPlanSaveQueue();
    let writes = 0;

    await queue.schedule('doc', 3, async () => {
      writes += 1;
    });
    await queue.schedule('doc', 3, async () => {
      writes += 1;
    });
    await queue.schedule('doc', 2, async () => {
      writes += 1;
    });

    expect(writes).toBe(1);
  });

  test('never lets a write for one document block another document', async () => {
    const queue = createPlanSaveQueue();
    const blocked = deferred();

    const blockedDone = queue.schedule('a', 1, async () => {
      await blocked.promise;
    });
    let otherRan = false;
    await queue.schedule('b', 1, async () => {
      otherRan = true;
    });

    expect(otherRan).toBe(true);
    blocked.resolve();
    await blockedDone;
  });

  test('pendingFor waits for the outstanding chain of that document only', async () => {
    const queue = createPlanSaveQueue();
    const slow = deferred();
    let slowSettled = false;

    void queue.schedule('a', 1, async () => {
      await slow.promise;
      slowSettled = true;
    });
    await queue.schedule('b', 1, async () => {});

    await queue.pendingFor('b');
    expect(slowSettled).toBe(false);

    slow.resolve();
    await queue.pendingFor('a');
    expect(slowSettled).toBe(true);
  });

  test('reset clears the revision watermark so a reloaded document can save again', async () => {
    const queue = createPlanSaveQueue();
    let writes = 0;

    await queue.schedule('doc', 5, async () => {
      writes += 1;
    });
    queue.reset('doc');
    await queue.schedule('doc', 1, async () => {
      writes += 1;
    });

    expect(writes).toBe(2);
  });

  test('a failed write does not poison the chain for later writes', async () => {
    const queue = createPlanSaveQueue();

    const failing = queue.schedule('doc', 1, async () => {
      throw new Error('write failed');
    });
    let secondRan = false;
    const second = queue.schedule('doc', 2, async () => {
      secondRan = true;
    });

    await expect(failing).rejects.toThrow('write failed');
    await second;
    expect(secondRan).toBe(true);
    await queue.pendingFor('doc');
  });

  test('allows the same revision to retry after its write fails', async () => {
    const queue = createPlanSaveQueue();
    let attempts = 0;

    const failing = queue.schedule('doc', 1, async () => {
      attempts += 1;
      throw new Error('write failed');
    });
    await expect(failing).rejects.toThrow('write failed');

    await queue.schedule('doc', 1, async () => {
      attempts += 1;
    });

    expect(attempts).toBe(2);
  });
});
