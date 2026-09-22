import { describe, expect, mock, test } from 'bun:test';

let nextFetchResponse = (): Response => new Response(null, { status: 500 });
mock.module('./runtime-fetch', () => ({ runtimeFetch: async () => nextFetchResponse() }));

const { ScheduledTaskRunError, runScheduledTaskNow } = await import('./scheduledTasksApi');

describe('runScheduledTaskNow', () => {
  test('preserves a denied run persistence warning', async () => {
    nextFetchResponse = () => new Response(JSON.stringify({
      error: 'Preflight denied this run',
      denied: true,
      persistError: 'Failed to save task state',
      task: {
        id: 'task-1',
        state: {
          createdAt: 100,
          updatedAt: 200,
          lastRunAt: 200,
          lastStatus: 'denied',
          lastError: 'Preflight denied this run',
        },
      },
    }), { status: 403, headers: { 'content-type': 'application/json' } });

    try {
      await runScheduledTaskNow('project-1', 'task-1');
      throw new Error('Expected the denied run to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduledTaskRunError);
      if (!(error instanceof ScheduledTaskRunError)) {
        throw error;
      }
      expect(error.message).toBe('Preflight denied this run');
      expect(error.persistError).toBe('Failed to save task state');
      expect(error.task).toEqual({
        id: 'task-1',
        state: {
          createdAt: 100,
          updatedAt: 200,
          lastRunAt: 200,
          lastStatus: 'denied',
          lastError: 'Preflight denied this run',
        },
      });
    }
  });
});
