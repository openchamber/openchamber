import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixLoopRuntime, DEFAULT_CONFIG } from '../pr-fix-loop/runtime.js';
import { createAutomationAdmission, pullRequestKey, sessionKey } from '../session-automation/runtime.js';
import { readPullFeedback, readFeedbackAuthorPermission, readFailedChecks } from '../github/pr-feedback.js';
import { createProductionBotPullRequests } from './production-pull-requests.js';
import { productionFixture } from './production-test-support.js';

let fixture;
let runtimes = [];
afterEach(async () => { for (const runtime of runtimes) await runtime.stop(); runtimes = []; await fixture?.close(); fixture = null; });

async function setup({ automation, notify, onFeedback } = {}) {
  const f = fixture = await productionFixture();
  const checkout = await f.makeWorktrees().create(f.request);
  Object.assign(f.item, { worktree: checkout.directory, branch: checkout.branch,
    pr: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: f.base } });
  const timers = [];
  const deliveries = [];
  let runtime;
  const adapters = createProductionBotPullRequests({ context: f.context, services: f.services, getFixLoopRuntime: () => runtime,
    receiveFeedback: async (projectId, itemId, event) => { deliveries.push({ projectId, itemId, ...event }); await onFeedback?.(adapters); },
    reviewApps: [{ slug: 'ai-review', appId: 77 }] });
  const makeRuntime = () => {
    runtime = createFixLoopRuntime({ dataDir: f.dataDir, botWatch: adapters.botWatch, automation, notify,
      getOctokit: async () => { throw new Error('Ambient user account must never be read'); },
      readFeedback: readPullFeedback, readAuthorPermission: readFeedbackAuthorPermission, readFailedChecks,
      isSessionWorking: async () => false, hasQueuedItem: async () => false,
      enqueue: async () => { throw new Error('Ordinary user-loop queue must never receive bot feedback'); },
      setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
      clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }, log: { warn() {} },
    });
    runtimes.push(runtime);
    return runtime;
  };
  makeRuntime();
  const runNext = async () => { expect(timers.length).toBeGreaterThan(0); await timers.shift().fn(); };
  const thread = (id, author, typename = 'User') => ({ id: `thread-${id}`, isResolved: false, isOutdated: false,
    path: 'fixed.js', line: 1, comments: { pageInfo: { hasPreviousPage: false, hasNextPage: false }, nodes: [
      { databaseId: id, body: `Please fix feedback ${id}`, url: `https://github.com/acme/app/pull/7#${id}`,
        createdAt: new Date().toISOString(), author: { __typename: typename, login: author } },
    ] } });
  return { ...f, timers, deliveries, adapters, makeRuntime, runNext, thread, runtime };
}

describe('production PR watch uses the existing loop and GitHub feedback owner', () => {
  test('more than 10 feedback turns use the exact bot identity and survive restart', async () => {
    const f = await setup();
    await f.adapters.pullRequests.ensureLoop(f.request);
    for (let index = 1; index <= 12; index += 1) {
      f.state.feedback = [f.thread(index, 'maintainer')];
      await f.runNext();
    }
    expect(f.deliveries.length).toBe(12);
    expect(f.deliveries.every((event) => event.projectId === f.project.id && event.itemId === f.item.id)).toBe(true);
    expect(new Set(f.deliveries.map((event) => event.eventId)).size).toBe(12);
    expect(f.deliveries.at(-1).text).toContain('managed bot tool');
    expect(f.deliveries.at(-1).text).not.toContain(' of 10');
    expect(f.deliveries.at(-1).text).not.toContain('`gh`');
    expect(f.state.requests.every((request) => request.authorization === 'Bearer fixture-selected-token')).toBe(true);
    const loop = (await f.runtime.list())[0];
    expect(loop.status).toBe('working');
    expect(loop.totalIterations).toBe(12);
    expect(loop).not.toHaveProperty('botAuthority');
    await expect(f.runtime.assertHostDispatch(f.item.sessions.fixing, f.item.worktree, { id: loop.id })).rejects.toThrow('verified feedback');
    await expect(f.runtime.update(loop.id, { maxIterations: 1 })).rejects.toThrow('belongs to the bot runtime');
    await f.runtime.stop();
    const restarted = f.makeRuntime();
    await restarted.start();
    f.state.feedback = [f.thread(13, 'maintainer')];
    await f.runNext();
    expect(f.deliveries.length).toBe(13);
    expect((await restarted.list())[0].totalIterations).toBe(13);
    await f.adapters.pullRequests.stop(f.request);
    expect((await restarted.list())[0].status).toBe('stopped');
    expect(DEFAULT_CONFIG.maxIterations).toBe(10);
  });

  test('a bot watch reserves its pull request and leaves the fixing session to the bot notices', async () => {
    const automation = createAutomationAdmission();
    await automation.ready();
    const f = await setup({ automation });

    await f.adapters.pullRequests.ensureLoop(f.request);

    // The host queue leases a bot notice with no owner on the session key.
    const noticeSend = automation.trySend(null, [sessionKey(f.item.sessions.fixing)]);
    expect(noticeSend).toBeInstanceOf(Function);
    noticeSend();
    const pull = pullRequestKey({ provider: 'github', instance: 'github.com', owner: 'acme', repo: 'app', number: 7 });
    expect(() => automation.claim('fixloop:another', [pull])).toThrow('owned by another automation');
    await f.adapters.pullRequests.stop(f.request);
    expect(() => automation.claim('fixloop:another', [pull])).not.toThrow();
  });

  test('a merged bot pull request settles with the authority that names its item', async () => {
    const settled = [];
    const f = await setup({ notify: async (loop) => { settled.push(loop); } });
    await f.adapters.pullRequests.ensureLoop(f.request);
    f.state.merged = true;

    await f.runNext();

    expect(settled.length).toBe(1);
    expect(settled[0]).toMatchObject({ status: 'closed', statusReason: 'merged', sessionId: f.item.sessions.fixing, number: 7,
      botAuthority: { project: { id: f.project.id }, botId: f.bot.id, itemId: f.item.id } });
    expect((await f.runtime.list())[0]).not.toHaveProperty('botAuthority');
  });

  test('reading the pull request again leaves the attached watch on its own schedule', async () => {
    // Each watch tick wakes the coordinator, which reads the pull request. A read
    // that made the watch tick at once would close that circle into a hot loop.
    const f = await setup();
    await f.adapters.pullRequests.ensureLoop(f.request);
    await f.runNext();
    const waiting = f.timers.map((timer) => timer.ms);

    await f.adapters.pullRequests.read(f.request);
    await f.adapters.pullRequests.ensureLoop(f.request);

    expect(waiting.length).toBe(1);
    expect(waiting[0]).toBeGreaterThan(0);
    expect(f.timers.map((timer) => timer.ms)).toEqual(waiting);
    expect((await f.runtime.list()).length).toBe(1);
  });

  test('a pull request closed without merging gets no new watch on later reads', async () => {
    const f = await setup();
    await f.adapters.pullRequests.ensureLoop(f.request);
    f.state.closed = true;
    await f.runNext();
    expect((await f.runtime.list()).map((loop) => loop.status)).toEqual(['closed']);

    await f.adapters.pullRequests.read(f.request);
    await f.adapters.pullRequests.read(f.request);

    expect((await f.runtime.list()).length).toBe(1);
    expect(f.timers).toEqual([]);
  });

  test('feedback whose delivery stops the watch does not wait on the tick that delivers it', async () => {
    // The coordinator revokes an active merge admission before it hands feedback
    // to the session, and that revocation stops the watch.
    const f = await setup({ onFeedback: (adapters) => adapters.pullRequests.stop(f.request) });
    await f.adapters.pullRequests.ensureLoop(f.request);
    f.state.feedback = [f.thread(1, 'maintainer')];

    const finished = await Promise.race([f.runNext().then(() => 'finished'),
      new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 3_000); })]);

    expect(finished).toBe('finished');
    expect(f.deliveries.length).toBe(1);
    expect((await f.runtime.list())[0].status).toBe('stopped');
  });

  test('AI review apps need an exact approved slug and provider app ID; human feedback still needs write access', async () => {
    const f = await setup();
    await f.adapters.pullRequests.ensureLoop(f.request);
    f.state.feedback = [f.thread(1, 'unapproved[bot]', 'Bot')];
    await f.runNext();
    expect(f.deliveries).toEqual([]);
    f.state.permission = 'read';
    f.state.feedback = [f.thread(2, 'outsider')];
    await f.runNext();
    expect(f.deliveries).toEqual([]);
    f.state.feedback = [f.thread(3, 'ai-review[bot]', 'Bot')];
    await f.runNext();
    expect(f.deliveries.length).toBe(1);
    expect(f.state.requests.some((request) => request.path === '/apps/ai-review')).toBe(true);
    const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'pr-fix-loops.json'), 'utf8'));
    expect(stored.loops[0].botAuthority.identityId).toBe((await f.identities.list())[0].id);
  });

  test('PR admission reads exact head/base, approval and queue rules without issuing a mutation', async () => {
    const f = await setup();
    f.state.mergeQueue = true;
    f.state.approved = true;
    expect(await f.adapters.pullRequests.read(f.request)).toEqual({ headSha: f.base, baseSha: f.base,
      merged: false, approved: true, mergeMode: 'queue' });
    const writes = f.state.requests.filter((request) => request.method !== 'GET' && request.path !== '/graphql');
    expect(writes).toEqual([]);
    f.state.failReads = true;
    await expect(f.adapters.pullRequests.read(f.request)).rejects.toMatchObject({ code: 'BOT_SERVICE_REJECTED' });
  });

  test('credential rotation blocks reads but cannot strand stopping the owned feedback loop', async () => {
    const f = await setup();
    await f.adapters.pullRequests.ensureLoop(f.request);
    const identity = (await f.identities.list())[0];
    await f.identities.remove(identity.id, identity.revision);
    await expect(f.adapters.pullRequests.read(f.request)).rejects.toMatchObject({ code: 'BOT_IDENTITY_REQUIRED' });
    await f.adapters.pullRequests.stop(f.request);
    expect((await f.runtime.list())[0].status).toBe('stopped');
  });

  test('admission uses the existing service mutation journal and only GitHub queue admission', async () => {
    const f = await setup();
    f.state.mergeQueue = true;
    const status = await f.adapters.pullRequests.read(f.request);
    const binding = (await f.context.serviceContext({ ...f.request, service: 'github', operation: 'pr.auto-merge' })).github;
    const input = { number: 7, headSha: status.headSha, baseSha: status.baseSha, branch: f.item.branch, mode: status.mergeMode, mergeMethod: 'SQUASH' };
    const envelope = await f.services.prepare({ key: 'item-1:merge', operation: 'pr.auto-merge', botId: f.bot.id, itemId: f.item.id, ...binding, input });
    const result = await f.services.execute(envelope, input);
    expect(result.result.status).toBe('enqueued');
    await f.services.execute(envelope, input);
    expect(f.state.admissions).toEqual([{ mode: 'queue', id: 'PR_7', head: f.base }]);
    expect(f.state.requests.some((request) => request.path.endsWith('/merge'))).toBe(false);
  });
});
