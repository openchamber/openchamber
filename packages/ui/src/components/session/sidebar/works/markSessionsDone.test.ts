import { afterEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { takeSessionActionFailure } from '@/sync/session-action-failures';
import { markSessionsDone } from './workActions';

// SAFETY: markSessionsDone reads only the id and directory.
const session = (id: string): Session => ({ id, directory: '/repo', time: { created: 1, updated: 1 } } as Session);

type Write = NonNullable<Parameters<typeof markSessionsDone>[1]>;

const initialRuntimeKey = getRuntimeKey();

afterEach(() => {
  if (getRuntimeKey() !== initialRuntimeKey) switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: initialRuntimeKey });
});

describe('markSessionsDone', () => {
  test('marks every session done, four at a time, and reports the ones that failed', async () => {
    let running = 0;
    let peak = 0;
    const written: string[] = [];
    const write: Write = async (id, directory, state) => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      written.push(`${id}:${directory}:${state}`);
      if (id === 'b') throw new Error('folder is gone');
      return session(id);
    };

    const result = await markSessionsDone(['a', 'b', 'c', 'd', 'e', 'f'].map(session), write);

    expect(result).toEqual({ doneIds: ['a', 'c', 'd', 'e', 'f'], failedIds: ['b'] });
    expect([...written].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => `${id}:/repo:done`));
    expect(peak).toBe(4);
    // The cause waits for the bulk bar's failure toast.
    expect(takeSessionActionFailure(['b'])?.message).toBe('folder is gone');
  });

  test('sends nothing more once the runtime switches away and back, and reports the batch stale', async () => {
    const pending: Array<() => void> = [];
    const written: string[] = [];
    const write: Write = (id) => new Promise((resolve) => {
      written.push(id);
      pending.push(() => resolve(session(id)));
    });

    const run = markSessionsDone(['a', 'b', 'c', 'd', 'e', 'f'].map(session), write);
    expect(written).toEqual(['a', 'b', 'c', 'd']);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: initialRuntimeKey });
    for (const resolve of pending) resolve();

    expect(await run).toBeNull();
    expect(written).toEqual(['a', 'b', 'c', 'd']);
  });

  test('a write the runtime switch dropped makes the batch stale', async () => {
    const write: Write = async (id) => (id === 'b' ? null : session(id));

    expect(await markSessionsDone([session('a'), session('b')], write)).toBeNull();
  });
});
