import { beforeEach, expect, mock, test } from 'bun:test';
import type { Metadata } from '@/lib/opencode/model';

let metadata: Metadata;
let writeResult: Promise<void>;
const abortGoalStatuses: unknown[] = [];

// Objective creation and its UI feedback are not part of status changes.
mock.module('@/lib/smallModel', () => ({ distillGoalObjective: mock() }));
mock.module('@/lib/i18n', () => ({ formatMessage: mock(), useI18nStore: { getState: mock() } }));
mock.module('@/components/ui', () => ({ toast: { error: mock() } }));
mock.module('@/lib/goalObjectiveFiles', () => ({ deleteGoalObjectiveFile: mock(), writeGoalObjectiveFile: mock() }));

mock.module('@/sync/session-actions', () => ({
  patchSessionMetadata: async (
    _sessionID: string,
    _directory: string | undefined,
    update: (current: Metadata) => Metadata,
  ) => {
    await writeResult;
    metadata = update(metadata);
  },
  abortCurrentOperation: async () => {
    const namespace = metadata.openchamber;
    const goal = namespace && typeof namespace === 'object' && !Array.isArray(namespace)
      ? namespace.goal
      : undefined;
    abortGoalStatuses.push(goal && typeof goal === 'object' && !Array.isArray(goal) ? goal.status : undefined);
  },
}));

const { setSessionGoalStatus } = await import('./sessionGoalActions');

beforeEach(() => {
  metadata = { openchamber: { goal: { id: 'goal-1', status: 'active', turnsUsed: 3 } } };
  writeResult = Promise.resolve();
  abortGoalStatuses.length = 0;
});

test('pause is persisted before abort can trigger a continuation', async () => {
  // Given a metadata write that has not committed yet.
  let commit = () => {};
  writeResult = new Promise<void>((resolve) => { commit = resolve; });

  // When the user pauses the running goal.
  const paused = setSessionGoalStatus('session-1', '/project', 'paused');
  const beforeCommit = [...abortGoalStatuses];
  commit();
  await paused;

  // Then an abort only observes an already-paused goal.
  expect(beforeCommit).toEqual([]);
  expect(abortGoalStatuses).toEqual(['paused']);
});

test('a failed pause write does not abort an active goal', async () => {
  // Given a write failure.
  writeResult = Promise.reject(new Error('metadata unavailable'));

  // When pausing fails.
  await expect(setSessionGoalStatus('session-1', '/project', 'paused')).rejects.toThrow('metadata unavailable');

  // Then the active operation is left alone.
  expect(abortGoalStatuses).toEqual([]);
});

test('explicit resume persists active status without aborting', async () => {
  // Given a paused goal.
  metadata = { openchamber: { goal: { id: 'goal-1', status: 'paused', turnsUsed: 3 } } };

  // When the user resumes it.
  await setSessionGoalStatus('session-1', '/project', 'active');

  // Then resume grants a fresh continuation allowance without an abort.
  expect(metadata).toMatchObject({ openchamber: { goal: { status: 'active', turnsUsed: 0 } } });
  expect(abortGoalStatuses).toEqual([]);
});
