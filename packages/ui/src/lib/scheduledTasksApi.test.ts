import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { deleteScheduledTask, fetchEligibleScheduledTaskTargets, fetchScheduledTasks, runScheduledTaskNow, upsertScheduledTask } from './scheduledTasksApi';

const requestSchema = z.object({ candidates: z.array(z.object({ sessionId: z.string(), directory: z.string() })) });

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

const candidates = (count: number) => Array.from({ length: count }, (_, index) => ({ sessionId: `ses_${index}`, directory: '/repo' }));

describe('fetchEligibleScheduledTaskTargets', () => {
  test('sends candidates in batches the route accepts and joins the answers', async () => {
    const batchSizes: number[] = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestSchema.parse(JSON.parse(String(init?.body)));
      batchSizes.push(body.candidates.length);
      return Response.json({ eligible: body.candidates.filter((_, index) => index % 2 === 0).map(({ sessionId }) => ({ sessionId })) });
    }, previousFetch);

    const eligible = await fetchEligibleScheduledTaskTargets('project-1', candidates(1200));

    expect(batchSizes).toEqual([500, 500, 200]);
    expect(eligible.size).toBe(600);
  });

  test('throws on a failed request or a malformed answer instead of returning an empty set', async () => {
    globalThis.fetch = Object.assign(async () => Response.json({ error: 'Rejected' }, { status: 500 }), previousFetch);
    await expect(fetchEligibleScheduledTaskTargets('project-1', candidates(1))).rejects.toThrow();

    globalThis.fetch = Object.assign(async () => Response.json({ nope: true }), previousFetch);
    await expect(fetchEligibleScheduledTaskTargets('project-1', candidates(1))).rejects.toThrow();
  });
});

describe('runScheduledTaskNow', () => {
  const answer = (response: Response) => {
    globalThis.fetch = Object.assign(async () => response, previousFetch);
  };

  test('reports a run the task recorded as skipped, as a Suggested tasks scan with nothing to do does', async () => {
    answer(Response.json({ ok: true, task: { id: 'suggested-tasks-scan', state: { lastStatus: 'skipped' } }, directory: '/repo' }));
    expect(await runScheduledTaskNow('project-1', 'suggested-tasks-scan')).toEqual({ directory: '/repo', skipped: true });
  });

  test('reports a started run with its session and no skip', async () => {
    answer(Response.json({ ok: true, sessionId: 'ses_1', directory: '/repo', task: { state: { lastStatus: 'running' } } }));
    expect(await runScheduledTaskNow('project-1', 'digest')).toEqual({ sessionId: 'ses_1', directory: '/repo', skipped: false });
  });

  test('keeps the rest of the answer when the task is missing or malformed', async () => {
    answer(Response.json({ ok: true, sessionId: 'ses_2', task: { state: 'unknown' } }));
    expect(await runScheduledTaskNow('project-1', 'digest')).toEqual({ sessionId: 'ses_2', skipped: false });
  });
});

describe('scheduled session notification contract', () => {
  const task = {
    id: 'daily', name: 'Daily', enabled: true,
    schedule: { kind: 'daily', times: ['09:00'] },
    execution: { prompt: 'Review the project.', useDefaults: true },
    state: { createdAt: 1, updatedAt: 1 },
  };
  const operations = [
    { name: 'read', run: () => fetchScheduledTasks('app') },
    { name: 'write', run: () => upsertScheduledTask('app', { name: 'Daily' }) },
    { name: 'delete', run: () => deleteScheduledTask('app', 'other') },
  ];
  for (const operation of operations) {
    test(`defaults notifications to finish on a legacy ${operation.name} response`, async () => {
      // Given a saved task without the notification field.
      globalThis.fetch = Object.assign(async () => Response.json({ tasks: [task] }), previousFetch);

      // When a task list response is parsed.
      const loaded = await operation.run();

      // Then legacy sessions retain finish notifications.
      expect(loaded[0]?.execution.notify).toBe('finish');
    });
    test(`preserves attention on a ${operation.name} response`, async () => {
      // Given an explicit attention-only choice.
      globalThis.fetch = Object.assign(async () => Response.json({ tasks: [{ ...task, execution: { ...task.execution, notify: 'attention' } }] }), previousFetch);

      // When the response is parsed.
      const loaded = await operation.run();

      // Then the notification policy survives.
      expect(loaded[0]?.execution.notify).toBe('attention');
    });
  }
  test('rejects malformed notification data instead of clearing the task list', async () => {
    // Given an invalid notification policy.
    globalThis.fetch = Object.assign(async () => Response.json({ tasks: [{ ...task, execution: { ...task.execution, notify: 'silent' } }] }), previousFetch);

    // When tasks load, then the read fails instead of returning an authoritative empty list.
    await expect(fetchScheduledTasks('app')).rejects.toThrow();
  });
});

describe('bot-managed scheduled task contract', () => {
  const task = { id: 'bot-row', name: 'Bot scan', enabled: true, botManaged: true, botId: 'bot-1',
    schedule: { kind: 'daily', times: ['09:00'] }, execution: { prompt: '', useDefaults: true }, state: { createdAt: 1, updatedAt: 1 } };
  test('retains managed ownership and the exact bot identifier from a task list', async () => {
    // Given a row owned by a bot, alongside an ordinary task.
    globalThis.fetch = Object.assign(async () => Response.json({ tasks: [task, { ...task, id: 'plain', botManaged: undefined, botId: undefined }] }), previousFetch);

    // When the list is parsed.
    const tasks = await fetchScheduledTasks('app');

    // Then rendering can route the managed row to its exact owner without changing ordinary rows.
    expect(tasks[0]).toMatchObject({ botManaged: true, botId: 'bot-1' });
    expect(tasks[1]?.botManaged).toBeUndefined();
  });
  test('rejects a managed row without a bot instead of granting ordinary task editing', async () => {
    // Given corrupt ownership that cannot name its editor.
    globalThis.fetch = Object.assign(async () => Response.json({ tasks: [{ ...task, botId: undefined }] }), previousFetch);

    // When the list loads, then ownership failure remains a failed read.
    await expect(fetchScheduledTasks('app')).rejects.toThrow();
  });
});
