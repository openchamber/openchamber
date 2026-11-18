import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createBotQuestions } from './questions.js';
import { questionsFixture, questionArea, questionPeople, questionCommit } from './questions-test-support.js';
import { enterprisePolicy } from './services/http.test-support.js';
import { botGit } from './production-git.js';

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const fixture = async (options) => { const h = await questionsFixture(options); cleanups.push(h.close); return h; };
const writes = (h) => h.upstream.requests.filter((request) => request.method === 'POST' && /\/(messages|comment)$/.test(request.path));

it('routes approved changed-path owners before requested role and journals exact recipients before one send', async () => {
  const h = await fixture();
  const result = await h.questions.ask({ ...h.input, requestedRole: 'tech-lead' });
  expect(result.question.route).toMatchObject({ selection: 'owners', service: 'discord',
    recipients: [{ personId: 'owner', serviceId: '44444444' }], binding: { target: { guildId: '11111111', channelId: '22222222' } } });
  expect(result.receipt).toEqual({ id: '33333333' });
  expect(result.item.wait).toMatchObject({ people: ['owner'], channel: 'discord' });
  expect(h.central.get('item')).toMatchObject({ botState: 'waiting-answer' });
  expect(h.controls.approvedAtSend).toEqual([result.question.key]);
  expect(h.controls.sentBody.allowed_mentions).toEqual({ parse: [], users: ['44444444'], roles: [], replied_user: false });
  expect(h.controls.sentBody.content).toBe('<@44444444>\n\nWhich behavior is expected?');
  expect(h.upstream.requests.some((request) => request.path.includes('/commits/'))).toBe(false);
  await h.questions.ask({ ...h.input, requestedRole: 'tech-lead' });
  expect(writes(h)).toHaveLength(1);
  const execution = await h.journal.read('project', 'item');
  expect(execution.operations[result.question.key].input.recipients).toEqual([{ personId: 'owner', serviceId: '44444444' }]);
  expect(execution.operations[result.question.key].prepared.operation).toBe('discord.question');
  expect(JSON.stringify(execution)).not.toMatch(/fixture-discord|secret-account/);
});

it.each([
  { area: questionArea(['missing']), label: 'unresolved owner' },
  { area: questionArea(['owner'], ['unrelated/**']), label: 'unmatched area' },
])('falls back to the role after $label using actual changed paths', async ({ area }) => {
  const h = await fixture({ area });
  const result = await h.questions.ask({ ...h.input, requestedRole: 'tech-lead' });
  expect(result.question.route).toMatchObject({ selection: 'role', recipients: [{ personId: 'lead' }] });
  expect(writes(h)).toHaveLength(1);
});

it('falls back after an owner lacks a service identity without contacting a partial owner set', async () => {
  const h = await fixture({ people: questionPeople.map((person) => person.id === 'owner' ? { ...person, discord: undefined } : person) });
  const result = await h.questions.ask({ ...h.input, requestedRole: 'tech-lead' });
  expect(result.question.route.selection).toBe('role');
  expect(result.item.wait.people).toEqual(['lead']);
});

it('maps server Git blame SHAs through GitHub commit accounts and the approved directory', async () => {
  const h = await fixture({ area: null });
  const result = await h.questions.ask({ ...h.input, requestedRole: 'absent-role' });
  expect(result.question.route).toMatchObject({ selection: 'blame', recipients: [{ personId: 'author', serviceId: '66666666' }],
    attribution: [{ sha: h.base, github: 'code-author', githubId: 77, files: ['src/core.js'] }] });
  expect(h.upstream.requests.some((request) => request.path === `/repos/acme/example/commits/${h.base}`)).toBe(true);
  expect(result.question.route.attribution[0].files).not.toContain('other.js');
  expect(JSON.stringify(result.question.route)).not.toMatch(/attacker@|Untrusted local author/);
});

it.each([null, 'not-approved', 'owner-gh'])('never infers identity from Git author text when the GitHub author is %s', async (author) => {
  const people = questionPeople.filter((person) => person.id === 'author');
  const h = await fixture({ area: null, people });
  h.controls.commitAuthor = author;
  const result = await h.questions.ask(h.input);
  expect(result.question.route).toBeNull();
  expect(result.question.code).toBe('BOT_QUESTION_RECIPIENT_UNRESOLVED');
  expect(result.item).toMatchObject({ state: 'waiting-answer', wait: { channel: 'ui', people: [] } });
  expect(writes(h)).toHaveLength(0);
  expect(h.central.has('item')).toBe(true);
});

it('rejects a GitHub response for another SHA and preserves the waiting question', async () => {
  const h = await fixture({ area: null });
  h.controls.commitSha = 'f'.repeat(40);
  const result = await h.questions.ask(h.input);
  expect(result.question.code).toBe('BOT_QUESTION_COMMIT_MISMATCH');
  expect(writes(h)).toHaveLength(0);
});

it('uses no identities from an unapproved directory or changed area', async () => {
  const h = await fixture();
  await fs.writeFile(path.join(h.directory, '.agents/areas/core.md'), questionArea(['author']));
  const result = await h.questions.ask({ ...h.input, requestedRole: 'tech-lead' });
  expect(result.question.route.selection).toBe('role');
  expect(result.item.wait.people).toEqual(['lead']);
  await h.questions.answered({ projectId: 'project', itemId: 'item' });
  await h.mutate((item) => ({ ...item, state: 'fixing', wait: undefined }));
  await fs.writeFile(path.join(h.directory, '.openchamber/people.json'), JSON.stringify([{ ...questionPeople[0], discord: '99999999' }]));
  const untrusted = await h.questions.ask({ ...h.input, eventId: 'fixing:1:question' });
  expect(untrusted.question.code).toBe('BOT_QUESTION_PEOPLE_UNTRUSTED');
  expect(untrusted.item.wait.channel).toBe('ui');
  expect(writes(h)).toHaveLength(1);
});

it('validates explicit person IDs even when area ownership could otherwise resolve', async () => {
  const h = await fixture();
  const result = await h.questions.ask({ ...h.input, people: ['arbitrary-github-login'] });
  expect(result.question.code).toBe('BOT_QUESTION_PERSON_UNAPPROVED');
  expect(writes(h)).toHaveLength(0);
});

it('mentions only approved selected recipients on the original Jira issue without requiring Discord setup', async () => {
  const h = await fixture({ source: 'jira' });
  const settings = await h.config.read('project');
  settings.definitions[0].discord.channels = [];
  await h.config.update('project', settings);
  const result = await h.questions.ask(h.input);
  expect(result.question.route).toMatchObject({ service: 'jira', recipients: [{ personId: 'owner', serviceId: 'jira-owner' }],
    binding: { target: { projectKey: 'TEST', issueKey: 'TEST-7' } } });
  expect(writes(h)[0].path).toBe('/rest/api/3/issue/TEST-7/comment');
  expect(h.controls.sentBody.body.content[0].content).toEqual([{ type: 'mention', attrs: { id: 'jira-owner' } }]);
  expect(h.controls.sentBody.body.content[1].content).toEqual([{ type: 'text', text: 'Which behavior is expected?' }]);
});

it('keeps ambiguous Discord destinations central and creates no DM or guessed channel', async () => {
  const h = await fixture();
  const settings = await h.config.read('project');
  settings.definitions[0].discord.channels.push({ guildId: '11111111', channelId: '99999999' });
  await h.config.update('project', settings);
  const result = await h.questions.ask(h.input);
  expect(result.question.code).toBe('BOT_DISCORD_DESTINATION_AMBIGUOUS');
  expect(result.item.wait.channel).toBe('ui');
  expect(writes(h)).toHaveLength(0);
  expect(h.upstream.requests.some((request) => request.path.includes('/users/@me/channels'))).toBe(false);
});

it('retains the original event key and request across unknown outcomes, restart and changed input', async () => {
  const h = await fixture();
  h.controls.loseWrite = true;
  const first = await h.questions.ask(h.input);
  expect(first.question.code).toBe('BOT_SERVICE_UNAVAILABLE');
  expect(first.item.effects[0].state).toBe('outcome-unknown');
  const before = await h.journal.read('project', 'item');
  const restarted = createBotQuestions(h.dependencies);
  await restarted.retry({ project: h.project, bot: h.bot, itemId: 'item' });
  await expect(restarted.ask({ ...h.input, eventId: 'invented-retry' })).rejects.toMatchObject({ code: 'BOT_QUESTION_PENDING' });
  await expect(restarted.ask({ ...h.input, questions: ['Changed content'] })).rejects.toMatchObject({ code: 'BOT_QUESTION_INPUT_CHANGED' });
  await expect(restarted.answered({ projectId: 'project', itemId: 'item' })).rejects.toMatchObject({ code: 'BOT_EFFECT_UNSETTLED' });
  expect((await h.journal.read('project', 'item')).operations).toEqual(before.operations);
  expect(writes(h)).toHaveLength(1);
});

it('retains same-key pre-dispatch repair after enterprise refusal and revalidates the captured destination', async () => {
  const h = await fixture({ policyOptions: enterprisePolicy() });
  const first = await h.questions.ask(h.input);
  expect(first.question.code).toBe('enterprise_mode');
  expect(first.item.effects[0].state).toBe('prepared');
  expect(writes(h)).toHaveLength(0);
  const settings = await h.config.read('project');
  settings.definitions[0].discord.channels = [{ guildId: '11111111', channelId: '99999999' }];
  await h.config.update('project', settings);
  const retry = await h.questions.retry({ project: h.project, bot: h.bot, itemId: 'item' });
  expect(retry.question.key).toBe(first.question.key);
  expect(retry.question.code).toBe('BOT_QUESTION_TARGET_CHANGED');
  expect(writes(h)).toHaveLength(0);
});

it('does not clear authorization or budget attention and does not reopen an answered event', async () => {
  const h = await fixture();
  await h.questions.ask(h.input);
  await h.questions.answered({ projectId: 'project', itemId: 'item' });
  await h.mutate((item) => ({ ...item, state: 'fixing', wait: undefined }));
  const replay = await h.questions.ask(h.input);
  expect(replay.answered).toBe(true);
  expect(replay.item.state).toBe('fixing');
  await h.mutate((item) => ({ ...item, state: 'in-review' }));
  const reviewed = await createBotQuestions(h.dependencies).ask(h.input);
  expect(reviewed.answered).toBe(true);
  expect(reviewed.item.state).toBe('in-review');
  await expect(h.questions.ask({ ...h.input, questions: ['Changed question'] })).rejects.toMatchObject({ code: 'BOT_QUESTION_INPUT_CHANGED' });
  await h.mutate((item) => ({ ...item, state: 'needs-you', wait: { reason: 'BOT_DAILY_TOKEN_BUDGET', since: 1, channel: 'ui', people: [] } }));
  await expect(h.questions.ask({ ...h.input, eventId: 'new-event' })).rejects.toMatchObject({ code: 'BOT_QUESTION_RESUME_REQUIRED' });
  expect((await h.store.read('project')).items[0].wait.reason).toBe('BOT_DAILY_TOKEN_BUDGET');
  expect(writes(h)).toHaveLength(1);
});

it('repairs a proven pre-dispatch enterprise refusal under the same durable key', async () => {
  let allowed = false;
  const policyOptions = { env: {}, readFile: () => JSON.stringify({ enterpriseMode: true, allowedBotDestinations: allowed
    ? [{ service: 'discord', origin: 'https://discord.com', resource: '11111111/22222222' }] : [] }) };
  const h = await fixture({ policyOptions });
  const first = await h.questions.ask(h.input);
  expect(first.item.effects[0].state).toBe('prepared');
  allowed = true;
  const second = await h.questions.retry({ project: h.project, bot: h.bot, itemId: 'item' });
  expect(second.question.key).toBe(first.question.key);
  expect(second.receipt).toEqual({ id: '33333333' });
  expect(second.item.effects[0].state).toBe('succeeded');
  expect(writes(h)).toHaveLength(1);
});

it('rechecks recipient approval after service preparation and leaves the original request prepared', async () => {
  const h = await fixture();
  const questions = createBotQuestions({ ...h.dependencies, services: { ...h.services,
    prepare: async (request) => {
      const prepared = await h.services.prepare(request);
      await fs.writeFile(path.join(h.directory, '.openchamber/people.json'), '[]');
      return prepared;
    } } });
  const result = await questions.ask(h.input);
  expect(result.question.code).toBe('BOT_QUESTION_POLICY_CHANGED');
  expect(result.item.effects[0].state).toBe('prepared');
  expect(writes(h)).toHaveLength(0);
});

it('does not let a read failure erase the question or select another identity', async () => {
  const h = await fixture();
  h.controls.denyAuth = true;
  const first = await h.questions.ask(h.input);
  expect(first.question.code).toBe('BOT_SERVICE_AUTH_REQUIRED');
  expect(first.item.state).toBe('waiting-answer');
  expect(writes(h)).toHaveLength(0);
  h.controls.denyAuth = false;
  const second = await h.questions.retry({ project: h.project, bot: h.bot, itemId: 'item' });
  expect(second.question.key).toBe(first.question.key);
  expect(writes(h)).toHaveLength(1);
});

it('restores journaled intent after failure before the waiting projection, without a replacement event', async () => {
  const h = await fixture();
  const failing = createBotQuestions({ ...h.dependencies, store: { ...h.store, update: async () => { throw new Error('Disk unavailable'); } } });
  await expect(failing.ask(h.input)).rejects.toThrow('Disk unavailable');
  const before = await h.journal.read('project', 'item');
  expect(before.data.pendingQuestion).toMatch(/^question:/);
  expect((await h.store.read('project')).items[0].state).toBe('fixing');
  expect(writes(h)).toHaveLength(0);
  const restored = await h.questions.retry({ project: h.project, bot: h.bot, itemId: 'item' });
  expect(restored.question.key).toBe(before.data.pendingQuestion);
  expect(restored.item.state).toBe('waiting-answer');
  expect(writes(h)).toHaveLength(1);
});

it('refuses a changed worktree snapshot after preparing a recipient request', async () => {
  const h = await fixture();
  const questions = createBotQuestions({ ...h.dependencies, services: { ...h.services,
    prepare: async (request) => {
      const prepared = await h.services.prepare(request);
      await questionCommit(h.checkout.directory, { 'src/core.js': 'export const value = 3;\n' });
      return prepared;
    } } });
  const result = await questions.ask(h.input);
  expect(result.question.code).toBe('BOT_QUESTION_SNAPSHOT_CHANGED');
  expect(result.item.effects[0].state).toBe('prepared');
  expect(writes(h)).toHaveLength(0);
});

it('rejects another Jira issue from a context resolver before preparing a write', async () => {
  const h = await fixture({ source: 'jira' });
  const questions = createBotQuestions({ ...h.dependencies, context: { ...h.context,
    serviceContext: async (request) => {
      const result = await h.context.serviceContext(request);
      return { ...result, jira: { ...result.jira, target: { projectKey: 'TEST', issueKey: 'TEST-8' } } };
    } } });
  const result = await questions.ask(h.input);
  expect(result.question.code).toBe('BOT_QUESTION_TARGET_CHANGED');
  expect(writes(h)).toHaveLength(0);
});

it('keeps a linked DM unusable when its recipient differs from every approved selection', async () => {
  const h = await fixture();
  const questions = createBotQuestions({ ...h.dependencies, context: { ...h.context,
    serviceContext: async (request) => {
      const result = await h.context.serviceContext(request);
      return { ...result, discord: { ...result.discord, target: { guildId: 'dm', channelId: '22222222', recipientId: '99999999' } } };
    } } });
  const result = await questions.ask({ ...h.input, requestedRole: 'tech-lead' });
  expect(result.question.route).toBeNull();
  expect(result.item.wait.channel).toBe('ui');
  expect(writes(h)).toHaveLength(0);
});

it.each(['rename', 'delete'])('blames pre-change files after a real Git %s', async (operation) => {
  const h = await fixture({ area: null });
  // Restore the original contents so Git detects a rename without a similarity guess.
  const original = path.join(h.checkout.directory, 'src/core.js');
  await fs.writeFile(original, 'export const value = 1;\n');
  if (operation === 'rename') await fs.rename(original, path.join(h.checkout.directory, 'src/moved.js'));
  else await fs.unlink(original);
  await botGit(h.checkout.directory, ['add', '-A']);
  await questionCommit(h.checkout.directory, {});
  const result = await h.questions.ask(h.input);
  expect(result.question.route).toMatchObject({ selection: 'blame', attribution: [{ sha: h.base, files: ['src/core.js'] }],
    recipients: [{ personId: 'author' }] });
  expect(writes(h)).toHaveLength(1);
});
