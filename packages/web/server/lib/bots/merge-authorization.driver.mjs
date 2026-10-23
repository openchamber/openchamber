import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMergeAuthorizationDriver } from './merge-authorization-test-support.js';

const results = [];
const scenario = async (name, run) => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-authorization-driver-');
  const driver = await createMergeAuthorizationDriver(root);
  try {
    const item = await driver.admit();
    const current = async (runtime = driver.runtime) => (await runtime.detail('project', item.id)).item;
    await run(driver, item, current);
    assert.ok(driver.upstream.origins.every((origin) => origin === 'https://api.github.com'));
    assert.ok(driver.writes().every((request) => !/mergePullRequest|jump:true/.test(request.body.query)));
    results.push({ scenario: name, passed: true, writes: driver.writes().length });
  } finally { await driver.close(); await fs.rm(root, { recursive: true, force: true }); }
};

for (const changed of ['head', 'base', 'policy']) await scenario(`${changed}-invalidation`, async (driver, item, current) => {
  await driver.runtime.pump('project');
  assert.equal(driver.remote.autoMerge, true);
  driver.remote.queued = true;
  driver.held.add('judge');
  if (changed === 'head') driver.controls.headSha = 'd'.repeat(40);
  if (changed === 'base') driver.controls.baseSha = 'e'.repeat(40);
  if (changed === 'policy') {
    const directory = path.join(driver.project.path, '.agents/areas');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'review.md'), '---\nname: Review\npaths: ["src/**"]\nlevel: human\nowners: []\n---\nReview required.\n');
  }
  driver.remote.beforeMutation = async () => assert.equal((await driver.journal.read('project', item.id)).data.admission.state, 'revoking');
  await driver.runtime.pump('project');
  assert.equal((await current()).state, 'judging');
  assert.equal(driver.remote.autoMerge, false);
  assert.equal(driver.remote.queued, false);
  assert.deepEqual(driver.writes().slice(1).map((request) => request.body.variables.id), ['PR_owned', 'PR_owned']);
});

await scenario('unchanged-head-new-generation', async (driver, item) => {
  await driver.runtime.pump('project');
  const first = (await driver.journal.read('project', item.id)).data.admission;
  driver.controls.baseSha = 'f'.repeat(40);
  await driver.runtime.pump('project');
  const second = (await driver.journal.read('project', item.id)).data.admission;
  assert.equal(first.headSha, second.headSha);
  assert.notEqual(first.key, second.key);
  assert.equal(second.round, 1);
  assert.equal(driver.writes().filter((request) => request.body.query.includes('enablePullRequestAutoMerge')).length, 2);
});

await scenario('stop-timeout-restart-disabled', async (driver, item, current) => {
  driver.remote.mode = 'queue';
  await driver.runtime.pump('project');
  driver.remote.autoMerge = true;
  driver.remote.lose = 'disable';
  await driver.runtime.stopItem('project', item.id);
  assert.equal((await current()).state, 'needs-you');
  assert.equal(driver.calls.removed.length, 0);
  const settings = await driver.config.read('project');
  settings.definitions[0].enabled = false;
  await driver.config.update('project', settings);
  const restarted = driver.restart();
  await restarted.pump('project');
  assert.equal((await current(restarted)).state, 'stopped');
  assert.equal(driver.remote.queued, false);
  assert.equal(driver.writes().filter((request) => request.body.query.includes('disablePullRequestAutoMerge')).length, 1);
});

await scenario('enterprise-refusal', async (driver, item, current) => {
  await driver.runtime.pump('project');
  driver.remote.blocked = true;
  await driver.runtime.stopItem('project', item.id);
  assert.match((await current()).wait.reason, /Remote auto-merge may still be active.*enterprise_mode/);
  assert.equal(driver.remote.autoMerge, true);
  assert.equal(driver.writes().length, 1);
  assert.equal(driver.calls.removed.length, 0);
});

await scenario('ambiguous-cancel-never-redispatched', async (driver, item, current) => {
  await driver.runtime.pump('project');
  driver.remote.lose = 'disable';
  driver.remote.applyLost = false;
  await driver.runtime.stopItem('project', item.id);
  const restarted = driver.restart();
  await restarted.pump('project');
  assert.match((await current(restarted)).wait.reason, /Remote auto-merge may still be active/);
  assert.equal(driver.writes().filter((request) => request.body.query.includes('disablePullRequestAutoMerge')).length, 1);
  assert.equal(driver.calls.removed.length, 0);
});

await scenario('unresolved-admission-remains-blocked', async (driver, item, current) => {
  driver.remote.lose = 'enable';
  driver.remote.applyLost = false;
  await driver.runtime.pump('project');
  await driver.runtime.stopItem('project', item.id);
  const restarted = driver.restart();
  await restarted.pump('project');
  assert.match((await current(restarted)).wait.reason, /BOT_ADMISSION_OUTCOME_UNKNOWN/);
  assert.equal(driver.calls.removed.length, 0);
});

await scenario('merge-wins-stop-race', async (driver, item, current) => {
  await driver.runtime.pump('project');
  driver.remote.mergeDuringRevoke = true;
  await driver.runtime.stopItem('project', item.id);
  assert.match((await current()).wait.reason, /GitHub merged before revocation was confirmed/);
  const data = (await driver.journal.read('project', item.id)).data;
  assert.equal(data.admission.state, 'merged');
  assert.equal(data.mergedObservation.merged, true);
  assert.equal(data.serviceResults[`${data.admission.key}:disable`].merged, true);
  assert.equal(driver.calls.removed.length, 0);
});

console.log(JSON.stringify({ results, liveGitHubQA: false, raceLimit: 'GitHub can merge before cancellation or while the host is offline' }, null, 2));
