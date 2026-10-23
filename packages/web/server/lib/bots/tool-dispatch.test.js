import fs from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createToolDispatchDriver } from './tool-dispatch-test-support.js';
import { createBotEffects } from './effects.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-tool-dispatch-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const driver = await createToolDispatchDriver(root);
  cleanups.push(driver.close);
  const item = await driver.admit();
  return { ...driver, item, current: async (runtime = driver.runtime) => (await runtime.detail('project', item.id)).item };
};

it('blocks a changed or fresh operation ID after a lost response and preserves the original unknown receipt', async () => {
  const driver = await fixture();
  driver.controls.loseResponse = true;
  await expect(driver.tool(driver.item, 'original')).rejects.toMatchObject({ state: 'outcome-unknown' });
  expect(driver.controls.writes).toBe(1);
  const original = (await driver.current()).effects.find((effect) => effect.key.endsWith(':tool:original'));
  driver.controls.loseResponse = false;
  await expect(driver.tool(driver.item, 'original', 'Changed content')).rejects.toMatchObject({ code: 'BOT_EFFECT_INPUT_CHANGED' });
  for (const [id, body, action] of [['replacement', 'Controlled comment', 'pr.comment'], ['changed', 'Changed content', 'pr.comment'], ['other-operation', 'Ignored', 'git.push']]) {
    await expect(driver.tool(driver.item, id, body, action)).rejects.toMatchObject({ code: 'BOT_EFFECT_UNSETTLED' });
  }
  expect(driver.controls.writes).toBe(1);
  expect((await driver.current()).effects.find((effect) => effect.key === original.key)).toEqual(original);
  expect((await driver.current()).effects.filter((effect) => effect.key.includes(':tool:'))).toHaveLength(1);
});

it('reconciles only the original key after restart and Resume never resends unknown comment content', async () => {
  const driver = await fixture();
  driver.controls.loseResponse = true;
  await expect(driver.tool(driver.item, 'original')).rejects.toMatchObject({ state: 'outcome-unknown' });
  const original = (await driver.mutations.list())[0];
  driver.controls.loseResponse = false;
  const restarted = driver.restart();
  await restarted.resume('project', driver.item.id);
  expect((await driver.current(restarted)).state).toBe('needs-you');
  await expect(driver.tool(driver.item, 'replacement')).rejects.toMatchObject({ code: 'BOT_EFFECT_UNSETTLED' });
  const reads = driver.upstream.requests.filter((entry) => entry.method === 'GET').length;
  driver.dependencies.worktrees.inspect = async () => { throw new Error('The current checkout cannot replace captured recovery input'); };
  await expect(driver.tool(driver.item, 'original')).rejects.toMatchObject({ state: 'outcome-unknown' });
  expect(driver.upstream.requests.filter((entry) => entry.method === 'GET').length).toBeGreaterThan(reads);
  expect(driver.controls.writes).toBe(1);
  expect(await driver.mutations.list()).toEqual([original]);
});

it.each(['identity', 'policy'])('retains a proven pre-dispatch %s denial as prepared and requires explicit Resume for the same logical key', async (failure) => {
  const driver = await fixture();
  driver.controls.afterPrepare = async () => {
    if (failure === 'identity') driver.controls.credentialAvailable = false;
    else driver.controls.blocked = true;
    driver.controls.afterPrepare = null;
  };
  await expect(driver.tool(driver.item, 'repair')).rejects.toThrow();
  const denied = await driver.current();
  const effect = denied.effects.find((entry) => entry.key.endsWith(':tool:repair'));
  expect(effect.state).toBe('prepared');
  expect(denied.state).toBe('needs-you');
  expect(driver.controls.writes).toBe(0);
  expect(await driver.mutations.list()).toEqual([]);
  driver.controls.credentialAvailable = true;
  driver.controls.blocked = false;
  await expect(driver.tool(driver.item, 'repair', 'Changed content')).rejects.toMatchObject({ code: 'BOT_EFFECT_INPUT_CHANGED' });
  await expect(driver.tool(driver.item, 'repair')).rejects.toMatchObject({ code: 'BOT_EFFECT_RESUME_REQUIRED' });
  await expect(driver.tool(driver.item, 'replacement')).rejects.toMatchObject({ code: 'BOT_EFFECT_UNSETTLED' });
  await driver.restart().resume('project', driver.item.id);
  const repaired = await driver.current();
  expect(repaired.state).toBe('fixing');
  expect(repaired.effects.find((entry) => entry.key === effect.key)).toMatchObject({ state: 'succeeded', inputDigest: effect.inputDigest, authority: effect.authority });
  expect(repaired.effects.filter((entry) => entry.key.includes(':tool:'))).toHaveLength(1);
  expect(driver.controls.writes).toBe(1);
  await driver.tool(driver.item, 'repair');
  expect(driver.controls.writes).toBe(1);
});

it('uses the authoritative unknown effect as the write barrier even without a private pending-tool pointer', async () => {
  const driver = await fixture();
  driver.controls.loseResponse = true;
  await expect(driver.tool(driver.item, 'original')).rejects.toThrow();
  await driver.journal.update('project', driver.item.id, (execution) => ({ ...execution, data: { ...execution.data, pendingTool: null } }));
  await driver.store.update('project', (snapshot) => ({ snapshot: { ...snapshot,
    items: snapshot.items.map((item) => item.id === driver.item.id ? { ...item, state: 'fixing', wait: undefined } : item) } }));
  driver.controls.loseResponse = false;
  await expect(driver.tool(driver.item, 'replacement')).rejects.toMatchObject({ code: 'BOT_EFFECT_UNSETTLED' });
  expect(driver.controls.writes).toBe(1);
});

it('restores attention after a crash between tool dispatch failure and the needs-you transition', async () => {
  const driver = await fixture();
  driver.controls.loseResponse = true;
  await expect(driver.tool(driver.item, 'original')).rejects.toThrow();
  await driver.store.update('project', (snapshot) => ({ snapshot: { ...snapshot,
    items: snapshot.items.map((item) => item.id === driver.item.id ? { ...item, state: 'fixing', wait: undefined } : item) } }));
  driver.controls.loseResponse = false;
  const restarted = driver.restart();
  await restarted.pump('project');
  expect((await driver.current(restarted)).state).toBe('needs-you');
  expect(driver.controls.writes).toBe(1);
  await expect(driver.tool(driver.item, 'replacement')).rejects.toMatchObject({ code: 'BOT_EFFECT_UNSETTLED' });
});

it('requires human Resume for a prepared tool even when a crash left the item in fixing', async () => {
  const driver = await fixture();
  driver.controls.afterPrepare = async () => { driver.controls.blocked = true; driver.controls.afterPrepare = null; };
  await expect(driver.tool(driver.item, 'prepared')).rejects.toThrow();
  await driver.store.update('project', (snapshot) => ({ snapshot: { ...snapshot,
    items: snapshot.items.map((item) => item.id === driver.item.id ? { ...item, state: 'fixing', wait: undefined } : item) } }));
  driver.controls.blocked = false;
  await expect(driver.tool(driver.item, 'prepared')).rejects.toMatchObject({ code: 'BOT_EFFECT_RESUME_REQUIRED' });
  expect(driver.controls.writes).toBe(0);
  const settings = await driver.config.read('project');
  settings.definitions[0].enabled = false;
  await driver.config.update('project', settings);
  const restarted = driver.restart();
  await restarted.pump('project');
  expect((await driver.current(restarted)).state).toBe('needs-you');
  await expect(restarted.resume('project', driver.item.id)).rejects.toMatchObject({ code: 'BOT_NOT_ENABLED' });
  settings.definitions[0].enabled = true;
  await driver.config.update('project', settings);
  await restarted.resume('project', driver.item.id);
  expect(driver.controls.writes).toBe(1);
});

it('keeps a terminal refusal immutable and never executes a replacement callback under that key', async () => {
  const driver = await fixture();
  const effects = createBotEffects({ store: driver.store, journal: driver.journal });
  const request = { projectId: 'project', itemId: driver.item.id, key: 'terminal-refusal', kind: 'pr.comment',
    authority: { service: 'github', identityId: 'exact', revision: 1, target: 'acme/example' }, request: { body: 'Original' },
    execute: async () => { throw Object.assign(new Error('Explicit refusal'), { state: 'refused', code: 'EXPLICIT_REFUSAL' }); },
    reconcile: async () => { throw new Error('Terminal refusal must not reconcile'); } };
  await expect(effects.run(request)).rejects.toMatchObject({ state: 'refused' });
  const refused = (await driver.current()).effects.find((effect) => effect.key === request.key);
  let replacementWrites = 0;
  await expect(effects.run({ ...request, execute: async () => { replacementWrites += 1; return { id: 'unexpected' }; } })).rejects.toMatchObject({ state: 'refused' });
  expect(replacementWrites).toBe(0);
  expect((await driver.current()).effects.find((effect) => effect.key === request.key)).toEqual(refused);
});

it('stops an unexecuted prepared tool without sending it and preserves uncertain tools on stop', async () => {
  const prepared = await fixture();
  prepared.controls.afterPrepare = async () => { prepared.controls.blocked = true; prepared.controls.afterPrepare = null; };
  await expect(prepared.tool(prepared.item, 'never-sent')).rejects.toThrow();
  expect((await prepared.runtime.stopItem('project', prepared.item.id)).item.state).toBe('stopped');
  expect(prepared.controls.writes).toBe(0);
  expect((await prepared.current()).effects.find((effect) => effect.key.endsWith(':tool:never-sent'))).toMatchObject({ state: 'refused', code: 'BOT_STOP_REQUESTED' });

  const unknown = await fixture();
  unknown.controls.loseResponse = true;
  await expect(unknown.tool(unknown.item, 'uncertain')).rejects.toThrow();
  const before = (await unknown.current()).effects.find((effect) => effect.key.endsWith(':tool:uncertain'));
  await expect(unknown.runtime.stopItem('project', unknown.item.id)).rejects.toMatchObject({ code: 'BOT_STOP_HAS_UNSETTLED_EFFECTS' });
  expect((await unknown.current()).effects.find((effect) => effect.key === before.key)).toEqual(before);
  expect(unknown.calls.removed).toEqual([]);
  expect(unknown.controls.writes).toBe(1);
});

it('retains the exact tool request when context fails before preparation and Resume repairs it without a new operation ID', async () => {
  const driver = await fixture();
  driver.controls.contextAvailable = false;
  await expect(driver.tool(driver.item, 'context')).rejects.toMatchObject({ code: 'BOT_IDENTITY_REQUIRED' });
  expect((await driver.current()).state).toBe('needs-you');
  expect(driver.controls.writes).toBe(0);
  driver.controls.contextAvailable = true;
  await driver.runtime.resume('project', driver.item.id);
  expect(driver.controls.writes).toBe(1);
  expect((await driver.current()).effects.find((effect) => effect.key.endsWith(':tool:context')).state).toBe('succeeded');
});

it('keeps an uncertain item blocked while an unrelated item can perform its own admitted tool operation', async () => {
  const driver = await fixture();
  driver.controls.loseResponse = true;
  await expect(driver.tool(driver.item, 'uncertain')).rejects.toThrow();
  driver.controls.loseResponse = false;
  const other = await driver.admit('unrelated');
  await expect(driver.tool(other, 'independent')).resolves.toMatchObject({ receipt: { id: '802' } });
  expect((await driver.current()).state).toBe('needs-you');
  expect(driver.controls.writes).toBe(2);
});
