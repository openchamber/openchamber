import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBotQuestions } from './questions.js';
import { questionsFixture } from './questions-test-support.js';

const fixture = await questionsFixture({ area: null });
try {
  fixture.controls.loseWrite = true;
  const first = await fixture.questions.ask({ ...fixture.input, requestedRole: 'missing-role' });
  assert.equal(first.question.route.selection, 'blame');
  assert.deepEqual(first.question.route.recipients, [{ personId: 'author', serviceId: '66666666' }]);
  assert.equal(first.question.route.attribution[0].sha, fixture.base);
  assert.equal(first.item.effects[0].state, 'outcome-unknown');
  const saved = await fixture.journal.read('project', 'item');
  await createBotQuestions(fixture.dependencies).retry({ project: fixture.project, bot: fixture.bot, itemId: 'item' });
  assert.deepEqual((await fixture.journal.read('project', 'item')).operations, saved.operations);
  assert.equal(fixture.controls.approvedAtSend.length, 1);
  assert.equal(fixture.central.get('item').botState, 'waiting-answer');
  assert.deepEqual(fixture.controls.sentBody.allowed_mentions, { parse: [], users: ['66666666'], roles: [], replied_user: false });
  assert.equal(fixture.controls.sentBody.content, '<@66666666>\n\nWhich behavior is expected?');
  console.log(JSON.stringify({ realGitBase: fixture.base, attribution: first.question.route.attribution,
    recipient: first.question.route.recipients, effectKey: first.question.key, writes: fixture.controls.approvedAtSend.length,
    outcome: first.item.effects[0].state, central: fixture.central.get('item').botState, discordRequest: fixture.controls.sentBody }));
} finally { await fixture.close(); }

const jira = await questionsFixture({ source: 'jira' });
try {
  const result = await jira.questions.ask(jira.input);
  assert.deepEqual(jira.controls.sentBody.body.content, [
    { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'jira-owner' } }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Which behavior is expected?' }] },
  ]);
  const { prepared, input } = (await jira.journal.read('project', 'item')).operations[result.question.key];
  const value = { key: prepared.key, operation: prepared.operation, botId: prepared.botId, itemId: prepared.itemId,
    identityId: prepared.authority.identityId, identityRevision: prepared.authority.identityRevision, target: prepared.target };
  const before = jira.controls.approvedAtSend.length;
  await assert.rejects(jira.services.prepare({ ...value, input: { ...input, recipients: [{ personId: 'lead', serviceId: 'jira-lead' }] } }),
    { code: 'BOT_QUESTION_RECIPIENT_DENIED' });
  await assert.rejects(jira.services.prepare({ ...value, input: { ...input, policyFingerprint: 'f'.repeat(64) } }),
    { code: 'BOT_QUESTION_RECIPIENT_DENIED' });
  await fs.writeFile(path.join(jira.directory, '.openchamber/people.json'), '[]');
  await assert.rejects(jira.services.execute(prepared, input), { code: 'BOT_QUESTION_AUTHORITY_REQUIRED' });
  assert.equal(jira.controls.approvedAtSend.length - before, 0);
  console.log(JSON.stringify({ jiraRequest: jira.controls.sentBody, deniedCases: ['other-approved-person', 'stale-fingerprint', 'unapproved-directory'],
    negativeAdditionalWrites: jira.controls.approvedAtSend.length - before }));
} finally { await jira.close(); }
