import { describe, expect, test } from 'bun:test';
import { createGitIndexMutationQueue, type GitIndexMutationDirection } from './gitIndexMutationQueue';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitMicrotask = async () => {
  await Promise.resolve();
};

describe('createGitIndexMutationQueue', () => {
  test('coalesces consecutive mutations with the same directory and direction', async () => {
    const calls: Array<{ direction: GitIndexMutationDirection; paths: string[] }> = [];
    const queue = createGitIndexMutationQueue({
      runMutation: async ({ direction, paths }) => {
        calls.push({ direction, paths });
      },
      onMutationComplete: () => {},
      onMutationError: () => {},
      onPathsComplete: () => {},
      scheduleFlush: () => queue.flush(),
    });

    queue.enqueue({ directory: '/repo', direction: 'stage', paths: new Set(['a.ts']) });
    queue.enqueue({ directory: '/repo', direction: 'stage', paths: new Set(['b.ts', 'a.ts']) });
    queue.flush();
    await waitMicrotask();

    expect(calls).toEqual([{ direction: 'stage', paths: ['a.ts', 'b.ts'] }]);
  });

  test('serializes mutations and preserves alternating direction order', async () => {
    const first = createDeferred<void>();
    const calls: Array<{ direction: GitIndexMutationDirection; paths: string[] }> = [];
    let callCount = 0;

    const queue = createGitIndexMutationQueue({
      runMutation: ({ direction, paths }) => {
        calls.push({ direction, paths });
        callCount += 1;
        return callCount === 1 ? first.promise : Promise.resolve();
      },
      onMutationComplete: () => {},
      onMutationError: () => {},
      onPathsComplete: () => {},
      scheduleFlush: () => queue.flush(),
    });

    queue.enqueue({ directory: '/repo', direction: 'stage', paths: new Set(['a.ts']) });
    queue.enqueue({ directory: '/repo', direction: 'unstage', paths: new Set(['a.ts']) });
    queue.flush();
    queue.flush();
    await waitMicrotask();

    expect(calls).toEqual([{ direction: 'stage', paths: ['a.ts'] }]);
    expect(queue.isRunning()).toBe(true);

    first.resolve();
    await waitMicrotask();
    await waitMicrotask();

    expect(calls).toEqual([
      { direction: 'stage', paths: ['a.ts'] },
      { direction: 'unstage', paths: ['a.ts'] },
    ]);
  });

  test('reports errors, completes paths, and continues the queue', async () => {
    const errors: unknown[] = [];
    const completedPaths: string[][] = [];
    const completedDirections: GitIndexMutationDirection[] = [];
    let callCount = 0;

    const queue = createGitIndexMutationQueue({
      runMutation: async ({ direction }) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error(`${direction} failed`);
        }
      },
      onMutationComplete: ({ direction }) => {
        completedDirections.push(direction);
      },
      onMutationError: (_mutation, error) => {
        errors.push(error);
      },
      onPathsComplete: (paths) => {
        completedPaths.push(paths);
      },
      scheduleFlush: () => queue.flush(),
    });

    queue.enqueue({ directory: '/repo', direction: 'stage', paths: new Set(['a.ts']) });
    queue.enqueue({ directory: '/repo', direction: 'unstage', paths: new Set(['b.ts']) });
    queue.flush();
    await waitMicrotask();
    await waitMicrotask();

    expect(errors).toHaveLength(1);
    expect(completedDirections).toEqual(['unstage']);
    expect(completedPaths).toEqual([['a.ts'], ['b.ts']]);
  });
});
