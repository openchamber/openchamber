import { describe, expect, it } from 'vitest';

import { withFileWriteLock } from './settings-file-lock.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('withFileWriteLock', () => {
  it('runs tasks for the same path one at a time, in order', async () => {
    const path = '/tmp/example-settings.json';
    const order = [];
    const first = deferred();

    const a = withFileWriteLock(path, async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    const b = withFileWriteLock(path, async () => {
      order.push('b-start');
      order.push('b-end');
    });

    // b must not start before a finishes, even though a is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a-start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('does not serialize tasks for different paths', async () => {
    const order = [];
    const first = deferred();

    const a = withFileWriteLock('/tmp/one.json', async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    const b = withFileWriteLock('/tmp/two.json', async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await b;
    expect(order).toEqual(['a-start', 'b-start', 'b-end']);
    first.resolve();
    await a;
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });

  it('keeps the queue alive and lets later tasks run after an earlier task throws', async () => {
    const path = '/tmp/example-settings-2.json';

    await expect(
      withFileWriteLock(path, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    let ran = false;
    await withFileWriteLock(path, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
