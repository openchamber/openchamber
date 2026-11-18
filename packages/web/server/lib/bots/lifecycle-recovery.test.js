import fs from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createBotDriver } from './runtime-test-support.js';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const fixture = async (options) => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-lifecycle-recovery-');
  roots.push(root);
  return createBotDriver(root, options);
};

it('reconciles the original Stop cleanup after removal succeeded and its response was lost', async () => {
  // Given a stopped item's cleanup removed its owned checkout before losing its response.
  const driver = await fixture({ held: ['investigation'] });
  const item = await driver.admit();
  await driver.runtime.pump('project');
  const remove = driver.dependencies.worktrees.remove;
  let removals = 0;
  let reconciliations = 0;
  driver.dependencies.worktrees.remove = async (request) => {
    removals += 1;
    await remove(request);
    throw new Error('Cleanup response lost');
  };
  driver.dependencies.worktrees.reconcile = async (request) => {
    expect(request.operation).toBe('remove');
    expect(request.bot.name).toBe('Bug bot');
    reconciliations += 1;
    return { state: 'succeeded', result: { id: item.id } };
  };
  await expect(driver.runtime.stopItem('project', item.id)).rejects.toMatchObject({ state: 'outcome-unknown' });
  const settings = await driver.config.read('project');
  await driver.config.update('project', { ...settings, definitions: settings.definitions.map((bot) => ({ ...bot, name: 'Updated bot' })) });
  // When Stop resumes after a process restart.
  const result = await driver.restart().stopItem('project', item.id);
  // Then cleanup settles through its original read-only recovery without another removal.
  expect(result.item.state).toBe('stopped');
  expect(removals).toBe(1);
  expect(reconciliations).toBe(1);
  expect(result.item.effects.find((effect) => effect.key === `${item.id}:cleanup`).state).toBe('succeeded');
});

it('replays a completed Jira transition when closure resumes after an uncertain cleanup', async () => {
  // Given Jira reached Done and no longer offers its completed transition.
  const driver = await fixture({ bot: { jira: { doneTransition: '31' } } });
  const context = driver.dependencies.serviceContext;
  driver.dependencies.serviceContext = async (request) => {
    if ((!request.operation || request.operation === 'jira.transition') && driver.calls.effects.some((effect) => effect.operation === 'jira.transition')) {
      throw Object.assign(new Error('Transition is no longer available'), { code: 'BOT_JIRA_TRANSITION_UNAVAILABLE' });
    }
    return context(request);
  };
  const remove = driver.dependencies.worktrees.remove;
  let removals = 0;
  driver.dependencies.worktrees.remove = async (request) => {
    removals += 1;
    await remove(request);
    throw new Error('Cleanup response lost');
  };
  driver.dependencies.worktrees.reconcile = async (request) => ({ state: 'succeeded', result: { id: request.item.id } });
  const item = await driver.admit({ kind: 'jira', id: 'BUG-1' });
  await driver.runtime.pump('project');
  driver.controls.merged = true;
  await driver.runtime.pump('project');
  expect((await driver.runtime.detail('project', item.id)).item.state).toBe('needs-you');
  expect(driver.calls.effects.filter((effect) => effect.operation === 'jira.transition')).toHaveLength(1);
  // When the original closure is resumed after restart.
  const result = await driver.restart().resume('project', item.id);
  // Then captured transition authority is replayed and the original cleanup reconciles.
  expect(result.item.state).toBe('done');
  expect(driver.calls.effects.filter((effect) => effect.operation === 'jira.transition')).toHaveLength(1);
  expect(removals).toBe(1);
});

it('keeps Stop blocked by an unrelated uncertain effect without reconciling cleanup', async () => {
  const driver = await fixture();
  const create = driver.dependencies.worktrees.create;
  driver.dependencies.worktrees.create = async (request) => { await create(request); throw new Error('Create response lost'); };
  const item = await driver.admit();
  await driver.runtime.pump('project');
  expect((await driver.runtime.detail('project', item.id)).item.effects.find((effect) => effect.kind === 'worktree.create').state).toBe('outcome-unknown');
  await expect(driver.restart().stopItem('project', item.id)).rejects.toMatchObject({ code: 'BOT_STOP_HAS_UNSETTLED_EFFECTS' });
  expect(driver.calls.removed).toEqual([]);
});

for (const action of ['stop-item', 'shutdown']) {
  it(`interrupts an active proof before waiting for the project owner during ${action}`, async () => {
    // Given a proof that cannot finish until its coordinator cancels it.
    const driver = await fixture();
    let started;
    let release;
    const entered = new Promise((resolve) => { started = resolve; });
    driver.dependencies.runProof = async (input, { signal } = {}) => {
      started(signal);
      await new Promise((resolve) => {
        release = resolve;
        signal?.addEventListener('abort', resolve, { once: true });
      });
      return { status: 'inconclusive', testSha: input.testSha, fixSha: input.fixSha,
        command: input.command, args: input.args, testExitCode: null, fixExitCode: null, reason: 'Proof interrupted' };
    };
    const runtime = driver.restart();
    const item = await driver.admit();
    const pumping = runtime.pump('project');
    const signal = await entered;
    let stopping;
    try {
      // When Stop or shutdown is requested while proof holds project ownership.
      stopping = action === 'stop-item' ? runtime.stopItem('project', item.id) : runtime.stop();
      expect(signal).toBeInstanceOf(AbortSignal);
      await Promise.race([stopping, new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('Proof prevented cancellation')), 2_000);
        stopping.finally(() => clearTimeout(timeout)).catch(() => {});
      })]);
      // Then no judge/publication begins and ownership is released after proof settles.
      expect(signal.aborted).toBe(true);
      await pumping;
      const current = (await runtime.detail('project', item.id)).item;
      expect(current.proof.status).toBe('inconclusive');
      expect(driver.calls.effects).toEqual([]);
      expect(current.state).toBe(action === 'stop-item' ? 'stopped' : 'proving');
    } finally {
      release();
      await pumping;
      await stopping?.catch(() => {});
    }
  });
}

it('resumes a budget-interrupted stage once through its captured owner after restart', async () => {
  // Given an interrupted correction with a repaired token budget.
  const driver = await fixture({ held: ['fixing'], bot: { limits: { dailyTokens: 20 } } });
  const item = await driver.admit();
  await driver.runtime.pump('project');
  const before = (await driver.runtime.detail('project', item.id)).item;
  expect(before.state).toBe('fixing');
  await driver.runtime.recordUsage({ sessionId: before.sessions.fixing, total: 20 });
  const settings = await driver.config.read('project');
  await driver.config.update('project', { ...settings, definitions: settings.definitions.map((bot) => ({ ...bot, limits: { ...bot.limits, dailyTokens: 1_000 } })) });
  const resumed = [];
  const restore = driver.dependencies.stages.resume;
  driver.dependencies.stages.resume = async (request) => { resumed.push(request); await restore(request); };
  // When explicit Resume runs under a fresh coordinator.
  const result = await driver.restart().resume('project', item.id);
  // Then the original placement is restored and one durable new attempt finishes the interrupted stage.
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toMatchObject({ sessionId: before.sessions.fixing, directory: before.worktree, stage: 'fixing', bot: { limits: { dailyTokens: 20 } } });
  expect(result.item.state).toBe('merging');
  expect(result.item.worktree).toBe(before.worktree);
  expect(result.item.sessions.fixing).not.toBe(before.sessions.fixing);
  expect(driver.calls.worktrees).toEqual([item.id]);
  expect(driver.calls.prompts.filter((prompt) => prompt.sessionID === result.item.sessions.fixing)).toHaveLength(1);
});
