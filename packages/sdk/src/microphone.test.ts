import { describe, expect, test } from 'bun:test';

import { createSampleQueue } from './microphone.ts';

const pull = (queue: ReturnType<typeof createSampleQueue>, length: number): number[] => {
  const out = new Float32Array(length);
  queue.pull(out);
  return [...out];
};

describe('createSampleQueue', () => {
  test('plays samples in order across pushes and pads a short queue with silence', () => {
    const queue = createSampleQueue(100);
    queue.push(new Float32Array([1, 2, 3]));
    queue.push(new Float32Array([4, 5]));
    expect(pull(queue, 4)).toEqual([1, 2, 3, 4]);
    expect(queue.size).toBe(1);
    expect(pull(queue, 3)).toEqual([5, 0, 0]);
    expect(queue.size).toBe(0);
  });

  test('drops the oldest audio past its capacity, so the delay stays bounded', () => {
    const queue = createSampleQueue(4);
    queue.push(new Float32Array([1, 2]));
    queue.push(new Float32Array([3, 4]));
    queue.push(new Float32Array([5, 6]));
    expect(queue.size).toBe(4);
    expect(pull(queue, 4)).toEqual([3, 4, 5, 6]);
  });

  test('counts a partly played chunk by what is left of it', () => {
    const queue = createSampleQueue(4);
    queue.push(new Float32Array([1, 2, 3]));
    expect(pull(queue, 2)).toEqual([1, 2]);
    queue.push(new Float32Array([4, 5, 6]));
    expect(queue.size).toBe(4);
    expect(pull(queue, 4)).toEqual([3, 4, 5, 6]);
  });

  test('clear empties it', () => {
    const queue = createSampleQueue(10);
    queue.push(new Float32Array([1, 2]));
    queue.clear();
    expect(pull(queue, 2)).toEqual([0, 0]);
  });
});
