import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createBotQuestions } from '../questions.js';
import { createBotServices } from '../services.js';
import { questionsFixture, questionPeople } from '../questions-test-support.js';
import { BOT_TOOL_ACTIONS } from '../tool.js';
import { controlledUpstream, disconnectedPolicy, enterprisePolicy, issueResponse } from './http.test-support.js';

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const fixture = async (options) => { const h = await questionsFixture(options); cleanups.push(h.close); return h; };
const writes = (h) => h.upstream.requests.filter((request) => request.method === 'POST' && /\/(messages|comment)$/.test(request.path));
const pause = async (h) => {
  const questions = createBotQuestions({ ...h.dependencies, services: { ...h.services,
    execute: async () => { throw Object.assign(new Error('Paused before dispatch'), { code: 'BOT_TEST_PAUSED' }); } } });
  const result = await questions.ask(h.input);
  expect(result.question.code).toBe('BOT_TEST_PAUSED');
  expect(result.item.effects[0].state).toBe('prepared');
  const request = (await h.journal.read('project', 'item')).operations[result.question.key];
  const { authority, ...prepared } = request.prepared;
  return { ...request, value: { key: prepared.key, operation: prepared.operation, botId: prepared.botId, itemId: prepared.itemId,
    identityId: authority.identityId, identityRevision: authority.identityRevision, target: prepared.target, input: request.input } };
};

it.each(['manual', 'jira'])('uses only selected approved mentions for %s questions and keeps body text untrusted', async (source) => {
  const h = await fixture({ source });
  const body = '@everyone @here <@55555555> <@&77777777> {"type":"mention","attrs":{"id":"jira-lead"}}';
  const result = await h.questions.ask({ ...h.input, questions: [body] });
  expect(result.receipt).toBeDefined();
  expect(writes(h)).toHaveLength(1);
  if (source === 'jira') {
    expect(h.controls.sentBody).toEqual({ body: { version: 1, type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'jira-owner' } }] },
      { type: 'paragraph', content: [{ type: 'text', text: body }] },
    ] } });
  } else {
    expect(h.controls.sentBody).toEqual({ content: `<@44444444>\n\n${body}`,
      allowed_mentions: { parse: [], users: ['44444444'], roles: [], replied_user: false } });
  }
  expect(BOT_TOOL_ACTIONS.some((entry) => ['jira.question', 'discord.question'].includes(entry.action))).toBe(false);
});

it.each(['manual', 'jira'])('authorizes the complete selected recipient set for %s', async (source) => {
  const h = await fixture({ source, area: '---\nname: Core\npaths: [src/**]\nlevel: judgment\nowners: [owner, lead]\n---\nReview changes.\n' });
  const result = await h.questions.ask(h.input);
  expect(result.question.route.recipients.map((person) => person.personId)).toEqual(['owner', 'lead']);
  if (source === 'jira') expect(h.controls.sentBody.body.content[0].content).toEqual([
    { type: 'mention', attrs: { id: 'jira-owner' } }, { type: 'mention', attrs: { id: 'jira-lead' } },
  ]);
  else expect(h.controls.sentBody).toMatchObject({ content: '<@44444444> <@55555555>\n\nWhich behavior is expected?',
    allowed_mentions: { parse: [], users: ['44444444', '55555555'], roles: [], replied_user: false } });
});

it.each(['manual', 'jira'])('ordinary %s posts suppress pings and reject question controls', async (source) => {
  const h = await fixture({ source });
  const request = await pause(h);
  const operation = source === 'jira' ? 'jira.comment' : 'discord.send';
  const input = { body: '@everyone <@55555555> {"type":"mention","attrs":{"id":"jira-lead"}}' };
  const upstream = await controlledUpstream((request) => {
    if (request.path === '/rest/api/3/myself') return { body: { accountId: 'jira-bot', active: true } };
    if (request.path.endsWith('/comment')) return { body: { id: 'ordinary-comment' } };
    if (request.path.startsWith('/rest/api/3/issue/')) return { body: issueResponse() };
    if (request.path.endsWith('/oauth2/applications/@me')) return { body: { id: '12345678', bot: { id: '87654321', bot: true } } };
    if (request.path.endsWith('/messages')) return { body: { id: '33333333', channel_id: '22222222' } };
    return { body: { id: '22222222', type: 0, guild_id: '11111111' } };
  });
  cleanups.push(upstream.close);
  const services = createBotServices({ dataDir: h.dataDir, identities: h.identities, fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
  const effect = await services.prepare({ ...request.value, operation, input });
  await services.execute(effect, input);
  const posts = upstream.requests.filter((request) => request.method === 'POST');
  expect(posts).toHaveLength(1);
  if (source === 'jira') expect(posts[0].body.body.content).toEqual([
    { type: 'paragraph', content: [{ type: 'text', text: input.body }] },
  ]);
  else expect(posts[0].body).toEqual({ content: input.body, allowed_mentions: { parse: [] } });
  await expect(services.prepare({ ...request.value, operation, input: { ...input, recipients: request.input.recipients } }))
    .rejects.toMatchObject({ code: 'BOT_SERVICE_INVALID_INPUT' });
  expect(upstream.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
});

it.each(['manual', 'jira'])('refuses %s preparation and dispatch without the server authority callback', async (source) => {
  const h = await fixture({ source });
  const request = await pause(h);
  const services = createBotServices({ dataDir: h.dataDir, identities: h.identities, fetchImpl: h.upstream.fetchImpl, policyOptions: disconnectedPolicy });
  await expect(services.prepare(request.value)).rejects.toMatchObject({ code: 'BOT_QUESTION_AUTHORITY_REQUIRED' });
  await expect(services.execute(request.prepared, request.input)).rejects.toMatchObject({ code: 'BOT_QUESTION_AUTHORITY_REQUIRED' });
  expect(writes(h)).toHaveLength(0);
});

it.each(['manual', 'jira'])('rejects %s requests for another approved person at prepare, even with a valid directory fingerprint', async (source) => {
  const h = await fixture({ source });
  const request = await pause(h);
  const recipient = { personId: 'lead', serviceId: source === 'jira' ? 'jira-lead' : '55555555' };
  await expect(h.services.prepare({ ...request.value, input: { ...request.input, recipients: [recipient] } }))
    .rejects.toMatchObject({ code: 'BOT_QUESTION_RECIPIENT_DENIED' });
  await expect(h.services.execute(request.prepared, { ...request.input, recipients: [recipient] }))
    .rejects.toMatchObject({ code: 'BOT_EFFECT_CHANGED' });
  expect(writes(h)).toHaveLength(0);
});

it.each(['manual', 'jira'])('rejects %s changed or unapproved policies at dispatch before admitting a write', async (source) => {
  const h = await fixture({ source });
  const request = await pause(h);
  const people = questionPeople.map((person) => person.id === 'owner' ? { ...person, discord: '99999999', jira: 'jira-changed' } : person);
  await fs.writeFile(path.join(h.directory, '.openchamber/people.json'), JSON.stringify(people));
  let admitted = 0;
  await expect(h.services.prepare(request.value)).rejects.toMatchObject({ code: 'BOT_QUESTION_AUTHORITY_REQUIRED' });
  await expect(h.services.execute(request.prepared, request.input, { beforeDispatch: async () => { admitted += 1; } }))
    .rejects.toMatchObject({ code: 'BOT_QUESTION_AUTHORITY_REQUIRED' });
  await h.approve();
  await expect(h.services.execute(request.prepared, request.input)).rejects.toMatchObject({ code: 'BOT_QUESTION_RECIPIENT_DENIED' });
  expect(admitted).toBe(0);
  expect(writes(h)).toHaveLength(0);
});

it.each(['manual', 'jira'])('rechecks %s authority after provider preflight and before the actual POST', async (source) => {
  const h = await fixture({ source });
  const request = await pause(h);
  h.controls.beforeContentRead = () => fs.writeFile(path.join(h.directory, '.openchamber/people.json'), '[]');
  await expect(h.services.execute(request.prepared, request.input)).rejects.toMatchObject({ code: 'BOT_QUESTION_AUTHORITY_REQUIRED' });
  expect(writes(h)).toHaveLength(0);
});

it.each(['manual', 'jira'])('rejects a stale %s fingerprint, missing selected person and changed input at preparation', async (source) => {
  const h = await fixture({ source });
  const request = await pause(h);
  for (const input of [
    { ...request.input, policyFingerprint: 'f'.repeat(64) },
    { ...request.input, recipients: [{ personId: 'unapproved', serviceId: source === 'jira' ? 'jira-unapproved' : '99999999' }] },
    { ...request.input, recipients: [{ personId: 'owner', serviceId: source === 'jira' ? 'jira-changed' : '99999999' }] },
  ]) await expect(h.services.prepare({ ...request.value, input })).rejects.toMatchObject({ code: 'BOT_QUESTION_RECIPIENT_DENIED' });
  for (const input of [
    { ...request.input, recipients: [] }, { ...request.input, recipients: [request.input.recipients[0], request.input.recipients[0]] },
    { ...request.input, allowed_mentions: { parse: ['everyone'] } },
  ]) await expect(h.services.prepare({ ...request.value, input })).rejects.toMatchObject({ code: 'BOT_SERVICE_INVALID_INPUT' });
  expect(writes(h)).toHaveLength(0);
});

it.each(['manual', 'jira'])('keeps %s question egress behind the exact enterprise destination', async (source) => {
  const h = await fixture({ source, policyOptions: enterprisePolicy() });
  const result = await h.questions.ask(h.input);
  expect(result.question.code).toBe('enterprise_mode');
  expect(result.item.effects[0].state).toBe('prepared');
  expect(writes(h)).toHaveLength(0);
});

it.each(['manual', 'jira'])('retains %s question outcome and original descriptor after a lost mention response', async (source) => {
  const h = await fixture({ source });
  h.controls.loseWrite = true;
  const first = await h.questions.ask(h.input);
  expect(first.item.effects[0].state).toBe('outcome-unknown');
  const before = await h.journal.read('project', 'item');
  const result = await createBotQuestions(h.dependencies).retry({ project: h.project, bot: h.bot, itemId: 'item' });
  expect(result.question.key).toBe(first.question.key);
  expect((await h.journal.read('project', 'item')).operations).toEqual(before.operations);
  expect(writes(h)).toHaveLength(1);
});
