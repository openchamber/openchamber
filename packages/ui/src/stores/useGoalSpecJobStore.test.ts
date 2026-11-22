import { beforeEach, describe, expect, test } from 'bun:test';

import type { GoalSpecJob } from '@/lib/goalSpecJobs';
import { useGoalSpecJobStore } from './useGoalSpecJobStore';

const job = (overrides: Partial<GoalSpecJob> = {}): GoalSpecJob => ({
  id: 'j1',
  sessionId: 's1',
  directory: '/repo',
  status: 'writing',
  error: null,
  cancelled: false,
  content: 'build it',
  attachmentCount: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

// Oracle: the server's job order (updatedAt only grows for one job). The
// store ends on the newest state whatever order the events arrive in.
describe('goal spec job store', () => {
  beforeEach(() => useGoalSpecJobStore.getState().reset());

  test('a late, older update does not undo a newer one', () => {
    const store = useGoalSpecJobStore.getState();
    store.upsert(job({ status: 'failed', error: 'down', updatedAt: 5 }));
    store.upsert(job({ status: 'writing', updatedAt: 2 }));
    expect(useGoalSpecJobStore.getState().jobs.j1).toMatchObject({ status: 'failed', updatedAt: 5 });
  });

  test('generated event orders settle on the newest state', () => {
    let seed = 11;
    for (let run = 0; run < 200; run += 1) {
      useGoalSpecJobStore.getState().reset();
      const versions = [1, 2, 3, 4, 5].map((at) => job({ updatedAt: at, status: at === 5 ? 'failed' : 'writing' }));
      for (let index = versions.length - 1; index > 0; index -= 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const swap = seed % (index + 1);
        [versions[index], versions[swap]] = [versions[swap], versions[index]];
      }
      for (const version of versions) useGoalSpecJobStore.getState().upsert(version);
      expect(useGoalSpecJobStore.getState().jobs.j1.updatedAt).toBe(5);
    }
  });

  test('a removal drops only that job, and a full read replaces everything', () => {
    const store = useGoalSpecJobStore.getState();
    store.upsert(job());
    store.upsert(job({ id: 'j2' }));
    store.remove({ id: 'j1' });
    expect(Object.keys(useGoalSpecJobStore.getState().jobs)).toEqual(['j2']);
    store.replaceAll([job({ id: 'j3' })]);
    expect(Object.keys(useGoalSpecJobStore.getState().jobs)).toEqual(['j3']);
  });
});
