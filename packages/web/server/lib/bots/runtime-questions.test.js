import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createBotDriver } from './runtime-test-support.js';
import { createBotExecutionStore } from './execution-store.js';
import { readRepositoryPolicy } from './repository-policy.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async (options = {}) => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-runtime-questions-');
  roots.push(root);
  const driver = await createBotDriver(root, { held: ['fixing'], ...options,
    bot: { identity: { jira: { identityId: 'jira-account' } }, ...options.bot } });
  await fs.mkdir(path.join(root, '.openchamber'));
  await fs.writeFile(path.join(root, '.openchamber/people.json'), JSON.stringify([
    { id: 'directory-lead', name: 'Lead', roles: ['tech-lead'], github: 'lead-login', jira: 'jira-lead' },
  ]));
  const policy = await readRepositoryPolicy(root);
  await driver.config.setApproval('project', policy.people.file, policy.people.fingerprint);
  const item = await driver.admit({ kind: 'jira', id: 'BUG-1' });
  const journal = createBotExecutionStore({ store: driver.store });
  return { ...driver, item, journal,
    current: async () => (await driver.runtime.detail('project', item.id)).item,
    execution: () => journal.read('project', item.id),
    ask: (operationId = 'ask-once') => driver.runtime.handleTool({ sessionId: [...driver.sessions.values()].find((session) => session.metadata.openchamber.automation.stage === 'fixing')?.id,
      action: 'item.ask', input: { operationId, question: 'Which API should remain?', people: ['directory-lead'] } }),
  };
};
const writes = (driver) => driver.calls.effects.filter((effect) => effect.key.startsWith('question:'));
const blockPreparation = (driver) => {
  const execute = driver.dependencies.services.execute;
  let blocked = true;
  driver.dependencies.services.execute = async (prepared, ...args) => {
    if (blocked && prepared.key.startsWith('question:')) throw Object.assign(new Error('Reconnect service'), { code: 'BOT_SERVICE_AUTH_REQUIRED' });
    return execute(prepared, ...args);
  };
  return () => { blocked = false; };
};

it('routes investigation questions through the durable owner with a stable round and captured resume state', async () => {
  const driver = await fixture({ questions: ['Which API should remain?'], requestedRole: 'tech-lead' });
  await driver.runtime.pump('project');
  const execution = await driver.execution();
  const question = execution.data.questions[execution.data.pendingQuestion];
  expect(question.input).toMatchObject({ eventId: 'investigation:0', resumeState: 'fixing', requestedRole: 'tech-lead' });
  expect((await driver.current()).wait).toMatchObject({ channel: 'jira', people: ['directory-lead'] });
  expect(writes(driver)).toHaveLength(1);
  await driver.restart().pump('project');
  expect(writes(driver)).toHaveLength(1);
  await driver.runtime.answer('project', driver.item.id, { eventId: 'reply', text: 'Keep it compatible' });
  expect((await driver.execution()).data.pendingQuestion).toBeNull();
  expect((await driver.current()).state).toBe('fixing');
  expect(driver.calls.prompts[1].text).toContain('Keep it compatible');
});

it('routes judge questions using original directory IDs, not the judgment GitHub logins', async () => {
  const driver = await fixture({ held: [], decision: 'ask', reviewers: ['directory-lead'] });
  await driver.runtime.pump('project');
  const item = await driver.current();
  const execution = await driver.execution();
  expect(item.judgment.reviewers).toEqual(['lead-login']);
  expect(execution.data.questions[execution.data.pendingQuestion].input).toMatchObject({ eventId: 'judge:0', resumeState: 'judging', people: ['directory-lead'] });
  expect(item.wait.people).toEqual(['directory-lead']);
  expect(writes(driver)).toHaveLength(1);
  driver.controls.decision = 'review';
  await driver.runtime.answer('project', item.id, { eventId: 'judge-reply', text: 'Confirmed' });
  expect((await driver.current()).state).toBe('in-review');
  expect((await driver.execution()).data.round).toBe(1);
});

it('requires item.ask operation IDs, replays the same event while waiting and refuses a replacement ID', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  const sessionId = (await driver.current()).sessions.fixing;
  await expect(driver.runtime.handleTool({ sessionId, action: 'item.ask', input: { question: 'Missing ID' } })).rejects.toThrow();
  const first = await driver.ask();
  expect(first.question.input.resumeState).toBe('fixing');
  const replay = await driver.ask();
  expect(replay.question.key).toBe(first.question.key);
  expect(writes(driver)).toHaveLength(1);
  await expect(driver.ask('replacement')).rejects.toMatchObject({ code: 'BOT_QUESTION_PENDING' });
  await driver.runtime.answer('project', driver.item.id, { eventId: 'tool-reply', text: 'Keep the API' });
  expect((await driver.ask()).answered).toBe(true);
  expect((await driver.current()).state).toBe('fixing');
  await driver.ask('next-question');
  const pending = (await driver.execution()).data.pendingQuestion;
  await driver.runtime.answer('project', driver.item.id, { eventId: 'tool-reply', text: 'Keep the API' });
  expect((await driver.execution()).data.pendingQuestion).toBe(pending);
  expect((await driver.current()).state).toBe('waiting-answer');
  expect(driver.calls.notices).toHaveLength(1);
});

it('explicitly retries the original prepared question without creating another intent or write', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  const unblock = blockPreparation(driver);
  const first = await driver.ask();
  expect(first.question.code).toBe('BOT_SERVICE_AUTH_REQUIRED');
  expect((await driver.current()).effects.find((effect) => effect.key === first.question.key).state).toBe('prepared');
  await driver.restart().pump('project');
  expect(writes(driver)).toHaveLength(0);
  unblock();
  await driver.restart().resume('project', driver.item.id);
  expect((await driver.execution()).data.pendingQuestion).toBe(first.question.key);
  expect(writes(driver)).toHaveLength(1);
  expect((await driver.current()).state).toBe('waiting-answer');
});

it('restores a durable question intent saved before the wait transition, once, before stage progression', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  const update = driver.store.update;
  driver.store.update = async () => { throw new Error('Process stopped before wait commit'); };
  const bot = (await driver.config.read('project')).definitions[0];
  try {
    await expect(withSourceControlFileLock(`${driver.store.filePathFor('project')}.owner.lock`, () => driver.dependencies.questions.ask({
      project: driver.project, bot, itemId: driver.item.id, eventId: 'tool:interrupted', questions: ['Please confirm'], people: ['directory-lead'], resumeState: 'fixing',
    }))).rejects.toThrow('Process stopped');
  } finally { driver.store.update = update; }
  expect((await driver.current()).state).toBe('fixing');
  await driver.restart().pump('project');
  expect((await driver.current()).state).toBe('waiting-answer');
  expect(writes(driver)).toHaveLength(1);
  await driver.restart().pump('project');
  expect(writes(driver)).toHaveLength(1);
});

it.each(['permission', 'BOT_SERVICE_AUTH_REQUIRED', 'BOT_GOAL_TOKEN_BUDGET'])('keeps %s attention through automatic feedback, retry and answering until explicit Resume', async (reason) => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  await driver.ask();
  await driver.runtime.reportAttention({ projectId: 'project', itemId: driver.item.id, reason });
  await driver.runtime.receiveFeedback('project', driver.item.id, { eventId: 'provider-reply', text: 'Confirmed remotely' });
  await driver.restart().resume('project', driver.item.id);
  expect((await driver.current()).wait.reason).toBe(reason);
  expect((await driver.current()).state).toBe('needs-you');
  await driver.runtime.answer('project', driver.item.id, { eventId: 'provider-reply', text: 'Confirmed remotely' });
  expect((await driver.execution()).data.pendingQuestion).toBeNull();
  expect((await driver.current()).state).toBe('needs-you');
  await driver.restart().resume('project', driver.item.id);
  expect((await driver.current()).state).toBe('fixing');
  expect(driver.calls.notices).toHaveLength(1);
});

it('recovers an answered question after a crash between pointer settlement and the stage transition', async () => {
  const driver = await fixture({ held: [], decision: 'ask', reviewers: ['directory-lead'] });
  await driver.runtime.pump('project');
  driver.controls.decision = 'review';
  const answered = driver.dependencies.questions.answered;
  let interrupted = false;
  driver.dependencies.questions = { ...driver.dependencies.questions, answered: async (request) => {
    await answered(request);
    if (!interrupted) { interrupted = true; throw new Error('Process stopped after question settlement'); }
  } };
  // Restart the coordinator so it receives the wrapped real owner dependency.
  const runtime = driver.restart();
  await expect(runtime.answer('project', driver.item.id, { eventId: 'answered-before-crash', text: 'Confirmed' })).rejects.toThrow('Process stopped');
  expect((await driver.execution()).data.pendingQuestion).toBeNull();
  expect((await driver.current()).state).toBe('waiting-answer');
  await driver.restart().pump('project');
  const execution = await driver.execution();
  expect(execution.data.questionAnswer).toBeNull();
  expect(execution.data.round).toBe(1);
  expect((await driver.current()).state).toBe('in-review');
  expect(writes(driver)).toHaveLength(1);
  expect(driver.calls.notices).toHaveLength(1);
});

it('keeps a question pending when explicit retry fails the current token budget', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  const asked = await driver.ask();
  const settings = await driver.config.read('project');
  await driver.config.update('project', { ...settings, definitions: settings.definitions.map((bot) => ({ ...bot, limits: { ...bot.limits, dailyTokens: 1 } })) });
  await expect(driver.restart().resume('project', driver.item.id)).rejects.toMatchObject({ code: 'BOT_DAILY_TOKEN_BUDGET' });
  expect((await driver.execution()).data.pendingQuestion).toBe(asked.question.key);
  expect((await driver.current()).state).toBe('waiting-answer');
  expect(writes(driver)).toHaveLength(1);
});

it('refuses the exact unsent question on a UI answer and never dispatches it afterwards', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  blockPreparation(driver);
  const asked = await driver.ask();
  await driver.runtime.answer('project', driver.item.id, { eventId: 'local-answer', text: 'Confirmed locally' });
  expect((await driver.current()).effects.find((effect) => effect.key === asked.question.key)).toMatchObject({ state: 'refused', code: 'BOT_QUESTION_ANSWERED' });
  expect((await driver.execution()).data.pendingQuestion).toBeNull();
  expect((await driver.current()).state).toBe('fixing');
  expect(writes(driver)).toHaveLength(0);
});

it('Stop cancels a prepared question under its original key before cleanup', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  blockPreparation(driver);
  const asked = await driver.ask();
  const stopped = await driver.restart().stopItem('project', driver.item.id);
  expect(stopped.item.state).toBe('stopped');
  expect(stopped.item.effects.find((effect) => effect.key === asked.question.key)).toMatchObject({ state: 'refused', code: 'BOT_STOP_REQUESTED' });
  expect((await driver.execution()).data.pendingQuestion).toBeNull();
  expect(writes(driver)).toHaveLength(0);
  expect(driver.calls.removed).toEqual([driver.item.id]);
});

it('unknown question delivery blocks answers and Stop, and retries only reconcile the original write', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  const execute = driver.dependencies.services.execute;
  driver.dependencies.services.execute = async (prepared, ...args) => {
    if (prepared.key.startsWith('question:')) driver.controls.loseOperation = prepared.operation;
    return execute(prepared, ...args);
  };
  const asked = await driver.ask();
  expect((await driver.current()).effects.find((effect) => effect.key === asked.question.key).state).toBe('outcome-unknown');
  await driver.restart().resume('project', driver.item.id);
  expect(writes(driver)).toHaveLength(1);
  await expect(driver.runtime.answer('project', driver.item.id, { eventId: 'reply-unknown', text: 'Confirmed' })).rejects.toMatchObject({ code: 'BOT_EFFECT_UNSETTLED' });
  expect((await driver.execution()).data.pendingQuestion).toBe(asked.question.key);
  await expect(driver.restart().stopItem('project', driver.item.id)).rejects.toMatchObject({ code: 'BOT_STOP_HAS_UNSETTLED_EFFECTS' });
  expect(driver.calls.removed).toEqual([]);
  expect(writes(driver)).toHaveLength(1);
});
