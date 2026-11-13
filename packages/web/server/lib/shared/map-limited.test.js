import { describe, expect, it, vi } from 'vitest';

import { mapLimited } from './map-limited.js';

describe('mapLimited', () => {
  it('does no work for an empty input', async () => {
    const task = vi.fn();
    expect(await mapLimited([], 4, task)).toEqual([]);
    expect(task).not.toHaveBeenCalled();
  });

  it('calls the task once per item with only the item and preserves result identity', async () => {
    const items = [{ id: 1 }, { id: 2 }];
    const task = vi.fn((item) => item);
    const results = await mapLimited(items, 4, task);
    expect(task.mock.calls).toEqual([[items[0]], [items[1]]]);
    expect(results[0]).toBe(items[0]);
    expect(results[1]).toBe(items[1]);
  });

  it('fills available workers without exceeding the limit and keeps input order', async () => {
    const pending = Array.from({ length: 5 }, () => Promise.withResolvers());
    const nextStarted = Promise.withResolvers();
    const started = [];
    let active = 0;
    let peak = 0;
    const result = mapLimited([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      if (item === 2) nextStarted.resolve();
      active += 1;
      peak = Math.max(peak, active);
      await pending[item].promise;
      active -= 1;
      return `result-${item}`;
    });
    expect(started).toEqual([0, 1]);
    // Complete the second task first; its worker immediately takes the next.
    pending[1].resolve();
    await nextStarted.promise;
    expect(started).toEqual([0, 1, 2]);
    pending[2].resolve();
    pending[0].resolve();
    pending[3].resolve();
    pending[4].resolve();
    expect(await result).toEqual(['result-0', 'result-1', 'result-2', 'result-3', 'result-4']);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('propagates a rejection while another worker continues its remaining items', async () => {
    const failure = new Error('read failed');
    const blocked = Promise.withResolvers();
    const continued = Promise.withResolvers();
    const task = vi.fn((item) => {
      if (item === 0) return Promise.reject(failure);
      if (item === 1) return blocked.promise;
      continued.resolve();
      return item;
    });
    const result = mapLimited([0, 1, 2], 2, task);
    await expect(result).rejects.toBe(failure);
    expect(task.mock.calls).toEqual([[0], [1]]);
    blocked.resolve();
    await continued.promise;
    expect(task.mock.calls).toEqual([[0], [1], [2]]);
  });

  it('propagates a synchronous task error', async () => {
    const failure = new Error('invalid item');
    await expect(mapLimited([1], 4, () => { throw failure; })).rejects.toBe(failure);
  });
});
