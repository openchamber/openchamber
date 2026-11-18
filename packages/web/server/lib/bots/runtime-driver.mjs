import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBotDriver } from './runtime-test-support.js';

const directory = await fs.mkdtemp('/tmp/opencode/bot-owner-driver-');
try {
  const driver = await createBotDriver(directory, { decision: 'review', bot: { jira: { doneTransition: '31' } } });
  const admitted = await driver.admit({ kind: 'jira', id: 'BUG-1' });
  await driver.runtime.pump('project');
  assert.equal((await driver.runtime.detail('project', admitted.id)).item.state, 'in-review');
  driver.controls.approved = true;
  await driver.runtime.pump('project');
  driver.controls.merged = true;
  await driver.restart().pump('project');
  const { item } = await driver.runtime.detail('project', admitted.id);
  assert.equal(item.state, 'done');
  assert.equal(new Set(driver.calls.effects.map((effect) => effect.key)).size, driver.calls.effects.length);
  assert.equal(driver.calls.removed.length, 1);
  console.log(JSON.stringify({ mode: 'deterministic owner driver; no live provider or Git writes', state: item.state,
    transitions: item.transitions.map((transition) => transition.to), sessions: driver.calls.sessions.length,
    effects: driver.calls.effects.map((effect) => effect.operation), proof: item.proof.status, tokens: item.tokens.total,
  }, null, 2));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
