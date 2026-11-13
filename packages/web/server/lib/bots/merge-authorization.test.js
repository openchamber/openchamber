import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMergeAuthorizationDriver } from './merge-authorization-test-support.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-merge-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const driver = await createMergeAuthorizationDriver(root);
  cleanups.push(driver.close);
  const item = await driver.admit();
  return { ...driver, item, current: async (runtime = driver.runtime) => (await runtime.detail('project', item.id)).item };
};
const policyChange = async (driver) => {
  const directory = path.join(driver.project.path, '.agents', 'areas');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'review.md'), '---\nname: Review\npaths: ["src/**"]\nlevel: human\nowners: []\n---\nReview required.\n');
};
const mutations = (driver, name) => driver.writes().filter((entry) => entry.body.query.includes(name));

it.each(['head', 'base', 'policy'])('durably revokes both GitHub flags before invalidating %s judgment', async (changed) => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  expect(driver.remote.autoMerge).toBe(true);
  driver.remote.queued = true;
  driver.remote.beforeMutation = async (operation) => {
    if (!['disable', 'dequeue'].includes(operation)) return;
    expect((await driver.journal.read('project', driver.item.id)).data.admission).toMatchObject({ state: 'revoking', action: 'judge' });
    expect((await driver.current()).judgment).toBeDefined();
  };
  if (changed === 'head') driver.controls.headSha = 'd'.repeat(40);
  if (changed === 'base') driver.controls.baseSha = 'e'.repeat(40);
  if (changed === 'policy') await policyChange(driver);
  driver.held.add('judge');
  await driver.runtime.pump('project');
  expect(await driver.current()).toMatchObject({ state: 'judging', proof: { status: 'absent' } });
  expect((await driver.current()).judgment).toBeUndefined();
  expect(driver.remote).toMatchObject({ autoMerge: false, queued: false });
  const cancellations = driver.writes().slice(1);
  expect(cancellations.map((entry) => entry.body.query.match(/mutation (\w+)/)[1])).toEqual(['BotDisableAutoMerge', 'BotDequeue']);
  expect(cancellations.every((entry) => entry.body.variables.id === 'PR_owned')).toBe(true);
  const reads = driver.upstream.requests.map((entry) => entry.body?.query?.match(/(?:mutation|query) (\w+)/)?.[1]).filter(Boolean);
  const disable = reads.indexOf('BotDisableAutoMerge');
  const dequeue = reads.indexOf('BotDequeue');
  expect(reads.slice(disable + 1, dequeue)).toContain('BotAuthorization');
  expect(reads.slice(dequeue + 1)).toContain('BotAuthorization');
});

it('reauthorizes an unchanged head under a new base and round with a new durable key', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  const first = (await driver.journal.read('project', driver.item.id)).data.admission;
  driver.controls.baseSha = 'e'.repeat(40);
  await driver.runtime.pump('project');
  const next = (await driver.journal.read('project', driver.item.id)).data.admission;
  expect(next).toMatchObject({ state: 'active', headSha: first.headSha, baseSha: driver.controls.baseSha, round: 1 });
  expect(next.key).not.toBe(first.key);
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(2);
  expect((await driver.current()).effects.filter((effect) => effect.kind === 'pr.auto-merge').map((effect) => effect.state)).toEqual(['succeeded', 'succeeded']);
});

it('refuses a stale prepared admission after the final credential preparation and never enables it', async () => {
  const driver = await fixture();
  driver.remote.beforePrepare = async () => {
    driver.controls.baseSha = 'f'.repeat(40);
    driver.held.add('judge');
    driver.remote.beforePrepare = null;
  };
  await driver.runtime.pump('project');
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(0);
  expect((await driver.current()).effects.find((effect) => effect.kind === 'pr.auto-merge')).toMatchObject({ state: 'refused', code: 'BOT_ADMISSION_STALE' });
  expect((await driver.current()).state).toBe('judging');
});

it.each(['auto-merge', 'queue'])('revokes %s on explicit stop before removing the checkout', async (mode) => {
  const driver = await fixture();
  driver.remote.mode = mode;
  await driver.runtime.pump('project');
  driver.remote.autoMerge = true;
  driver.remote.queued = true;
  driver.remote.beforeMutation = async () => {
    const execution = await driver.journal.read('project', driver.item.id);
    expect(execution.data).toMatchObject({ stopRequested: true, admission: { state: 'revoking', action: 'stop' } });
    expect(driver.calls.removed).toEqual([]);
  };
  expect((await driver.runtime.stopItem('project', driver.item.id)).item.state).toBe('stopped');
  expect(driver.remote).toMatchObject({ autoMerge: false, queued: false });
  expect(driver.calls.removed).toEqual([driver.item.id]);
  expect(driver.writes().some((entry) => /mergePullRequest|jump:true/.test(entry.body.query))).toBe(false);
});

it.each(['disable', 'dequeue'])('recovers a lost %s response by reads under its original key after restart and disable', async (operation) => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  driver.remote.queued = true;
  driver.remote.lose = operation;
  expect((await driver.runtime.stopItem('project', driver.item.id)).item.state).toBe('needs-you');
  expect(driver.calls.removed).toEqual([]);
  const settings = await driver.config.read('project');
  settings.definitions[0].enabled = false;
  await driver.config.update('project', settings);
  const restarted = driver.restart();
  expect(await restarted.start()).toEqual({ failures: [] });
  expect((await driver.current(restarted)).state).toBe('stopped');
  expect(mutations(driver, 'disablePullRequestAutoMerge')).toHaveLength(1);
  expect(mutations(driver, 'dequeuePullRequest')).toHaveLength(1);
  expect((await driver.current(restarted)).effects.find((effect) => effect.kind === 'pr.disable-auto-merge').state).toBe('succeeded');
  await restarted.stop();
});

it.each(['disable', 'dequeue'])('keeps %s that may not have arrived blocked, with no retry under either key', async (operation) => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  driver.remote.queued = true;
  driver.remote.lose = operation;
  driver.remote.applyLost = false;
  await driver.runtime.stopItem('project', driver.item.id);
  const restarted = driver.restart();
  await restarted.pump('project');
  const current = await driver.current(restarted);
  expect(current).toMatchObject({ state: 'needs-you', wait: { reason: expect.stringContaining('Remote auto-merge may still be active') } });
  expect(operation === 'disable' ? driver.remote.autoMerge : driver.remote.queued).toBe(true);
  expect(driver.calls.removed).toEqual([]);
  expect(mutations(driver, operation === 'disable' ? 'disablePullRequestAutoMerge' : 'dequeuePullRequest')).toHaveLength(1);
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(1);
});

it('rejects invalidation at the provider dispatch boundary after its final GitHub preflight', async () => {
  const driver = await fixture();
  const services = driver.dependencies.services;
  const execute = services.execute;
  services.execute = (effect, input, options) => execute(effect, input, {
    ...options,
    beforeAdmission: async () => {
      driver.controls.baseSha = 'f'.repeat(40);
      driver.held.add('judge');
      await options.beforeAdmission();
    },
  });
  await driver.runtime.pump('project');
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(0);
  expect((await driver.current()).effects.find((effect) => effect.kind === 'pr.auto-merge')).toMatchObject({ state: 'refused', code: 'BOT_ADMISSION_STALE' });
  expect((await driver.current()).state).toBe('judging');
});

it('retires a persisted prepared admission on stop and cannot execute it after restart', async () => {
  const driver = await fixture();
  const inspect = driver.dependencies.worktrees.inspect;
  driver.remote.beforePrepare = async () => {
    driver.dependencies.worktrees.inspect = async () => { throw new Error('Preflight unavailable'); };
    driver.remote.beforePrepare = null;
  };
  await driver.runtime.pump('project');
  expect((await driver.current()).effects.find((effect) => effect.kind === 'pr.auto-merge').state).toBe('prepared');
  driver.dependencies.worktrees.inspect = inspect;
  expect((await driver.runtime.stopItem('project', driver.item.id)).item.state).toBe('stopped');
  await driver.restart().pump('project');
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(0);
  expect((await driver.current()).effects.find((effect) => effect.kind === 'pr.auto-merge')).toMatchObject({ state: 'refused', code: 'BOT_ADMISSION_REVOKED' });
});

it('conservatively revokes a legacy admission descriptor before issuing a fresh generation', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  await driver.journal.update('project', driver.item.id, (execution) => {
    delete execution.data.admission;
    return execution;
  });
  driver.held.add('judge');
  const restarted = driver.restart();
  await restarted.pump('project');
  expect((await driver.current(restarted)).state).toBe('judging');
  expect(driver.remote.autoMerge).toBe(false);
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(1);
  expect((await driver.journal.read('project', driver.item.id)).data.admission).toMatchObject({ state: 'revoked', round: 0 });
});

it('preserves remote-risk attention when enterprise mode refuses cancellation', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  driver.remote.blocked = true;
  await driver.runtime.stopItem('project', driver.item.id);
  expect(await driver.current()).toMatchObject({ state: 'needs-you', wait: { reason: expect.stringContaining('enterprise_mode') } });
  expect((await driver.current()).wait.reason).toContain('Remote auto-merge may still be active');
  expect(driver.remote.autoMerge).toBe(true);
  expect(driver.calls.removed).toEqual([]);
  expect(mutations(driver, 'disablePullRequestAutoMerge')).toHaveLength(0);
});

it('revokes an enabled bot when disabled and permits only a new generation after explicit resume', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  const first = (await driver.journal.read('project', driver.item.id)).data.admission;
  const settings = await driver.config.read('project');
  settings.definitions[0].enabled = false;
  await driver.runtime.saveConfig('project', settings);
  expect(await driver.current()).toMatchObject({ state: 'needs-you', wait: { reason: 'BOT_NOT_ENABLED' } });
  expect(driver.remote.autoMerge).toBe(false);
  settings.definitions[0].enabled = true;
  await driver.config.update('project', settings);
  await driver.runtime.resume('project', driver.item.id);
  const next = (await driver.journal.read('project', driver.item.id)).data.admission;
  expect(next.key).not.toBe(first.key);
  expect(next).toMatchObject({ headSha: first.headSha, baseSha: first.baseSha, round: 1 });
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(2);
});

it('reconciles a lost admission before revoking, without redispatching admission', async () => {
  const driver = await fixture();
  driver.remote.lose = 'enable';
  await driver.runtime.pump('project');
  expect((await driver.current()).state).toBe('needs-you');
  expect((await driver.runtime.stopItem('project', driver.item.id)).item.state).toBe('stopped');
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(1);
  expect(driver.remote.autoMerge).toBe(false);
});

it('does not let absent flags settle an unresolved original admission', async () => {
  const driver = await fixture();
  driver.remote.lose = 'enable';
  driver.remote.applyLost = false;
  await driver.runtime.pump('project');
  await driver.runtime.stopItem('project', driver.item.id);
  await driver.restart().pump('project');
  expect(await driver.current()).toMatchObject({ state: 'needs-you', wait: { reason: expect.stringContaining('BOT_ADMISSION_OUTCOME_UNKNOWN') } });
  expect(driver.calls.removed).toEqual([]);
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(1);
});

it('keeps failed authorization reads distinct from a confirmed empty authorization', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  driver.remote.failRead = true;
  await driver.runtime.stopItem('project', driver.item.id);
  expect(await driver.current()).toMatchObject({ state: 'needs-you', wait: { reason: expect.stringContaining('Remote auto-merge may still be active') } });
  expect((await driver.journal.read('project', driver.item.id)).data.admission.state).toBe('revoking');
  expect(driver.remote.autoMerge).toBe(true);
  expect(driver.calls.removed).toEqual([]);
});

it('blocks feedback work until revocation is confirmed and keeps cancellation operations internal', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  const sessionId = (await driver.current()).sessions.fixing;
  for (const action of ['pr.auto-merge', 'pr.disable-auto-merge', 'pr.dequeue', 'pr.merge']) {
    await expect(driver.runtime.handleTool({ sessionId, action, input: { operationId: 'forbidden' } })).rejects.toMatchObject({ code: 'BOT_ACTION_UNSUPPORTED' });
  }
  driver.remote.lose = 'disable';
  driver.remote.applyLost = false;
  await expect(driver.runtime.receiveFeedback('project', driver.item.id, { eventId: 'fix-feedback', text: 'Please fix this' })).rejects.toMatchObject({ code: 'BOT_REMOTE_AUTHORIZATION_UNCONFIRMED' });
  expect(driver.calls.notices).toEqual([]);
  expect((await driver.current()).state).toBe('needs-you');
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(1);
});

it.each(['stop', 'invalidation'])('records a merge winning the %s race without claiming cancellation', async (action) => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  driver.remote.mergeDuringRevoke = true;
  if (action === 'stop') await driver.runtime.stopItem('project', driver.item.id);
  else { driver.controls.baseSha = 'f'.repeat(40); await driver.runtime.pump('project'); }
  const execution = await driver.journal.read('project', driver.item.id);
  expect(execution.data).toMatchObject({ admission: { state: 'merged' }, mergedObservation: { merged: true } });
  expect(execution.data.serviceResults[`${execution.data.admission.key}:disable`]).toMatchObject({ merged: true });
  if (action === 'stop') {
    expect(await driver.current()).toMatchObject({ state: 'needs-you', wait: { reason: 'GitHub merged before revocation was confirmed' } });
    await driver.restart().pump('project');
    expect(driver.calls.removed).toEqual([]);
  } else expect((await driver.current()).state).toBe('done');
});

it('keeps the admission prepared while the repository disallows auto-merge, and sends it once allowed', async () => {
  const driver = await fixture();
  driver.remote.autoMergeAllowed = false;

  await driver.runtime.pump('project');

  expect(await driver.current()).toMatchObject({ state: 'needs-you', wait: { reason: 'BOT_GITHUB_AUTO_MERGE_DISABLED' } });
  expect((await driver.current()).effects.find((effect) => effect.kind === 'pr.auto-merge').state).toBe('prepared');
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(0);
  driver.remote.autoMergeAllowed = true;
  await driver.runtime.resume('project', driver.item.id);
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(1);
  expect((await driver.current()).effects.find((effect) => effect.kind === 'pr.auto-merge').state).toBe('succeeded');
});

it('closes after a person merges a pull request whose repository disallows auto-merge', async () => {
  const driver = await fixture();
  driver.remote.autoMergeAllowed = false;
  await driver.runtime.pump('project');
  driver.controls.merged = true;

  await driver.runtime.resume('project', driver.item.id);

  const closed = await driver.current();
  expect(closed.state).toBe('done');
  // An unsent admission is retired, so the finished item can be archived.
  expect(closed.effects.find((effect) => effect.kind === 'pr.auto-merge').state).toBe('refused');
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(0);
});

it.each(['merge', 'stop'])('settles an admission GitHub refused before the write, so %s can finish the item', async (ending) => {
  // The base moved between the coordinator's read and the provider's own check.
  const driver = await fixture();
  driver.remote.rulesBaseSha = 'f'.repeat(40);
  await driver.runtime.pump('project');
  expect(await driver.current()).toMatchObject({ state: 'needs-you', wait: { reason: 'BOT_SERVICE_TARGET_CHANGED' } });
  driver.remote.rulesBaseSha = null;

  if (ending === 'merge') {
    driver.controls.merged = true;
    await driver.runtime.resume('project', driver.item.id);
  } else await driver.runtime.stopItem('project', driver.item.id);

  const settled = await driver.current();
  expect(settled.state).toBe(ending === 'merge' ? 'done' : 'stopped');
  expect(settled.effects.find((effect) => effect.kind === 'pr.auto-merge')).toMatchObject({ state: 'refused', code: 'BOT_SERVICE_TARGET_CHANGED' });
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(0);
});

it('sends a new admission on Resume after a GitHub read failed once inside the first one', async () => {
  const driver = await fixture();
  // The check ahead of dispatch reads the pull request first; the second read is the provider's own.
  driver.remote.failPullReads = 2;
  await driver.runtime.pump('project');
  expect((await driver.current()).state).toBe('needs-you');
  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(0);

  await driver.runtime.resume('project', driver.item.id);

  expect(mutations(driver, 'enablePullRequestAutoMerge')).toHaveLength(1);
  expect(driver.remote.autoMerge).toBe(true);
  const admissions = (await driver.current()).effects.filter((effect) => effect.kind === 'pr.auto-merge').map((effect) => effect.state);
  expect(admissions).toEqual(['refused', 'succeeded']);
});

it('turns auto-merge off on a later Stop after a GitHub read failed during the first one', async () => {
  const driver = await fixture();
  await driver.runtime.pump('project');
  expect(driver.remote.autoMerge).toBe(true);
  driver.remote.failAuthorizationReads = 1;
  await driver.runtime.stopItem('project', driver.item.id);
  expect(driver.remote.autoMerge).toBe(true);

  await driver.runtime.stopItem('project', driver.item.id);
  await driver.runtime.stopItem('project', driver.item.id);

  expect(driver.remote.autoMerge).toBe(false);
  expect((await driver.current()).state).toBe('stopped');
});
