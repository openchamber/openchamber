import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createToolDispatchDriver } from './tool-dispatch-test-support.js';

const results = [];
const scenario = async (name, run) => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-tool-driver-');
  const driver = await createToolDispatchDriver(root);
  try {
    const item = await driver.admit();
    await run(driver, item);
    assert.ok(driver.upstream.origins.every((origin) => origin === 'https://api.github.com'));
    results.push({ scenario: name, passed: true, contentWrites: driver.controls.writes });
  } finally { await driver.close(); await fs.rm(root, { recursive: true, force: true }); }
};

await scenario('lost-response-new-key-blocked-original-key-read-only', async (driver, item) => {
  driver.controls.loseResponse = true;
  await assert.rejects(() => driver.tool(item, 'original'), { state: 'outcome-unknown' });
  const original = (await driver.mutations.list())[0];
  driver.controls.loseResponse = false;
  const restarted = driver.restart();
  await restarted.resume('project', item.id);
  assert.equal((await restarted.detail('project', item.id)).item.state, 'needs-you');
  await assert.rejects(() => driver.tool(item, 'original', 'Changed body'), { code: 'BOT_EFFECT_INPUT_CHANGED' });
  await assert.rejects(() => driver.tool(item, 'replacement'), { code: 'BOT_EFFECT_UNSETTLED' });
  const reads = driver.upstream.requests.filter((request) => request.method === 'GET').length;
  await assert.rejects(() => driver.tool(item, 'original'), { state: 'outcome-unknown' });
  assert.ok(driver.upstream.requests.filter((request) => request.method === 'GET').length > reads);
  assert.equal(driver.controls.writes, 1);
  assert.deepEqual(await driver.mutations.list(), [original]);
});

for (const failure of ['identity', 'policy']) await scenario(`${failure}-repair-explicit-resume-same-key`, async (driver, item) => {
  driver.controls.afterPrepare = async () => {
    if (failure === 'identity') driver.controls.credentialAvailable = false;
    else driver.controls.blocked = true;
    driver.controls.afterPrepare = null;
  };
  await assert.rejects(() => driver.tool(item, 'repair'));
  const denied = (await driver.runtime.detail('project', item.id)).item;
  const prepared = denied.effects.find((effect) => effect.key.endsWith(':tool:repair'));
  assert.equal(denied.state, 'needs-you');
  assert.equal(prepared.state, 'prepared');
  assert.equal(driver.controls.writes, 0);
  assert.deepEqual(await driver.mutations.list(), []);
  driver.controls.credentialAvailable = true;
  driver.controls.blocked = false;
  await assert.rejects(() => driver.tool(item, 'repair'), { code: 'BOT_EFFECT_RESUME_REQUIRED' });
  await assert.rejects(() => driver.tool(item, 'replacement'), { code: 'BOT_EFFECT_UNSETTLED' });
  const restarted = driver.restart();
  await restarted.resume('project', item.id);
  const repaired = (await restarted.detail('project', item.id)).item.effects.filter((effect) => effect.key.includes(':tool:'));
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].key, prepared.key);
  assert.equal(repaired[0].inputDigest, prepared.inputDigest);
  assert.equal(repaired[0].state, 'succeeded');
  assert.equal(driver.controls.writes, 1);
  await driver.tool(item, 'repair');
  assert.equal(driver.controls.writes, 1);
});

await scenario('missing-context-retains-logical-request', async (driver, item) => {
  driver.controls.contextAvailable = false;
  await assert.rejects(() => driver.tool(item, 'context'), { code: 'BOT_IDENTITY_REQUIRED' });
  assert.equal((await driver.runtime.detail('project', item.id)).item.state, 'needs-you');
  driver.controls.contextAvailable = true;
  await driver.runtime.resume('project', item.id);
  assert.equal(driver.controls.writes, 1);
  assert.equal((await driver.runtime.detail('project', item.id)).item.effects.find((effect) => effect.key.endsWith(':tool:context')).state, 'succeeded');
});

await scenario('one-uncertain-item-does-not-block-another', async (driver, item) => {
  driver.controls.loseResponse = true;
  await assert.rejects(() => driver.tool(item, 'uncertain'));
  driver.controls.loseResponse = false;
  const other = await driver.admit('other');
  await driver.tool(other, 'independent');
  assert.equal((await driver.runtime.detail('project', item.id)).item.state, 'needs-you');
  assert.equal(driver.controls.writes, 2);
});

console.log(JSON.stringify({ results, liveAuthentication: false,
  boundary: 'Real runtime, identity resolver, HTTP provider and mutation journals; controlled OpenCode and GitHub peers' }, null, 2));
