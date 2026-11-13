import { afterEach, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { createFixLoopRuntime, registerFixLoopRoutes } from './runtime.js';
import { destinationOf } from './approval-contract.js';
import { createAutomationAdmission, fixLoopOwner, sessionKey } from '../session-automation/runtime.js';

const head = 'a'.repeat(40);
const result = 'b'.repeat(40);
const input = { sessionId: 'ses_host', directory: '/repo', accountId: 'account', owner: 'upstream', repo: 'app', number: 7,
  readContext: { repositoryId: 'local-repo', accountId: 'account' }, config: { pushMode: 'approval' } };
const snapshot = () => ({ state: 'open', branch: 'fix', headSha: head, headRepo: { id: 'fork-id', owner: 'contributor', repo: 'app' },
  title: 'Fix', url: 'https://github.com/upstream/app/pull/7', viewer: 'user', reviewDecision: null,
  ci: { state: 'failure', total: 1, contexts: [] }, threads: [], reviews: [], comments: [] });
let directory;
let timers;
let sent;
let hostSent;
let published;
let stoppedWorkers;
let usable;
let remote;
let exported;
let usage;
let failPublication;
let reviewWrites;
let reviewReply;
let failExport;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-'));
  timers = []; sent = []; hostSent = []; published = []; stoppedWorkers = []; usable = true;
  remote = snapshot();
  exported = { result, changedPaths: 1, changedBytes: 10, unmerged: { count: 0 }, nestedRepositories: { count: 0 } };
  usage = 0;
  failPublication = false;
  reviewWrites = []; reviewReply = null;
  failExport = false;
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const make = (extra = {}) => createFixLoopRuntime({
  dataDir: directory, getOctokit: async () => ({}), readFeedback: async () => remote, readFailedChecks: async () => [],
  isSessionWorking: async () => false, hasQueuedItem: () => false, enqueue: async (...args) => hostSent.push(args),
  setTimer: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
  clearTimer: (timer) => { timers = timers.filter((entry) => entry !== timer); }, log: { warn() {} },
  workerRuntime: {
    prepare: async ({ parentSessionId, directory: hostDirectory, model }) => ({ id: crypto.randomUUID(), spaceId: 'aabbccddeeff',
      parentSessionId, directory: hostDirectory, model, sessionId: null, spacePath: null }),
    validate: async () => { if (!usable) throw new Error('protected worker unavailable'); },
    initialize: async (loop) => ({ ...loop.worker, sessionId: 'ses_worker', spacePath: '/spaces/aabbccddeeff/repo' }),
    enqueue: async (loop, item) => sent.push({ worker: loop.worker, item }), working: async () => false,
    usage: async () => usage, export: async () => { if (failExport) throw new Error('Export interrupted'); return exported; },
    reviewResult: async () => reviewReply ?? `\`\`\`openchamber-review-actions\n${JSON.stringify({
      turnId: /Use \{"turnId":"([^"]+)"/.exec(sent.at(-1).item.text)[1],
      actions: [{ kind: 'thread', id: 'PRRT_assigned', body: 'Fixed in the approved commit.', resolve: true }],
    })}\n\`\`\``,
    stop: async (loop) => stoppedWorkers.push(loop.worker.spaceId), resume: async () => { await extra.onResume?.(); },
  },
  publication: {
    validate: async () => {},
    capture: async (_loop, turn, output) => ({ receipt: { id: crypto.randomUUID(), commit: output.result,
      localRef: `refs/heads/openchamber-approval/${crypto.randomUUID()}`, repositoryId: 'local-repo',
      destination: destinationOf(turn), createdAt: 1, changedPaths: 1, changedBytes: 10 }, authority: { repositoryId: 'local-repo' } }),
    publish: async (_loop, pending) => { published.push(pending.receipt); await extra.onPublish?.(); if (failPublication) throw new Error('Publication response lost'); },
  },
  applyReviewOperation: async (operation) => { reviewWrites.push(structuredClone(operation)); },
  ...extra,
});
const tick = async () => { const timer = timers.shift(); if (!timer) throw new Error('No scheduled tick'); await timer.fn(); };
const activate = async (runtime, config = input.config) => {
  const worker = await runtime.prepareWorker({ sessionId: input.sessionId, directory: input.directory, model: { providerID: 'openai', modelID: 'chosen' } });
  return runtime.create({ ...input, config, workerId: worker.id, snapshot: remote });
};
const pending = async (runtime) => { const loop = await activate(runtime); await tick(); await tick(); return (await runtime.list()).find((entry) => entry.id === loop.id); };

test('approval turns use only the fresh worker and persist a receipt after export', async () => {
  // Given / When
  const runtime = make();
  const loop = await pending(runtime);
  // Then
  expect(hostSent).toEqual([]);
  expect(sent.map((entry) => entry.worker.sessionId)).toEqual(['ses_worker']);
  expect(loop.pendingApproval).toMatchObject({ commit: result, destination: { headRepo: { owner: 'contributor' }, expectedHead: head } });
  expect(JSON.parse(await fs.readFile(path.join(directory, 'pr-fix-loops.json'), 'utf8')).loops[0].pendingApproval).toEqual(loop.pendingApproval);
  expect(published).toEqual([]);
  runtime.stop();
});

test('untrusted review feedback stays in the protected approval worker without host author authority', async () => {
  remote.threads = [{ id: 'PRRT_assigned', resolved: false, path: 'file.js', line: 1, comments: [
    { id: 1, body: 'Untrusted review request', url: 'u', author: { login: 'outsider', bot: false } },
  ] }];
  const runtime = make({ readAuthorPermission: async () => { throw new Error('Host author authority must not be used for isolated approval work'); } });
  await activate(runtime);
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].item.text).toContain('Untrusted review request');
  expect(hostSent).toEqual([]);
  expect(published).toEqual([]);
  runtime.stop();
});

test('HTTP approval publishes the immutable receipt despite a newer worker result', async () => {
  // Given
  const runtime = make();
  const loop = await pending(runtime);
  exported.result = 'c'.repeat(40);
  loop.pendingApproval.commit = 'd'.repeat(40);
  const app = express(); app.use(express.json());
  registerFixLoopRoutes(app, { runtime, createWithContext: async () => {} });
  // When
  const response = await supertest(app).post(`/api/source-control/github/pr/fix-loops/${loop.id}/approve`).send({ receiptId: loop.pendingApproval.id });
  // Then
  expect(response.status).toBe(200);
  expect(published.map((entry) => entry.commit)).toEqual([result]);
  expect(response.body.loop.pendingApproval).toBeNull();
  runtime.stop();
});

test('a changed receipt id is refused without a publication', async () => {
  const runtime = make();
  const loop = await pending(runtime);
  await expect(runtime.approve(loop.id, crypto.randomUUID())).rejects.toThrow();
  expect(published).toEqual([]);
  runtime.stop();
});

test('a restart retains the pending receipt without another worker turn or host enqueue', async () => {
  const first = make();
  const loop = await pending(first); first.stop(); timers = [];
  const restarted = make(); await restarted.start(); await tick();
  expect((await restarted.list())[0].pendingApproval).toEqual(loop.pendingApproval);
  expect(sent).toHaveLength(1);
  expect(hostSent).toEqual([]);
  restarted.stop();
});

test('an interrupted publication reconciles the approved remote object after restart without another push', async () => {
  // Given
  const first = make(); const loop = await pending(first); failPublication = true;
  await expect(first.approve(loop.id, loop.pendingApproval.id)).rejects.toThrow();
  first.stop(); timers = []; remote.headSha = result;
  const restarted = make(); await restarted.start();
  // When
  const reconciled = await restarted.approve(loop.id, loop.pendingApproval.id);
  // Then
  expect(published).toHaveLength(1); expect(reconciled.pendingApproval).toBeNull();
  expect(sent).toHaveLength(1); expect(hostSent).toEqual([]);
  restarted.stop();
});

test('an old approval loop cannot start, update or resume on a host session', async () => {
  const first = make();
  const loop = await activate(first); first.stop(); timers = [];
  const file = path.join(directory, 'pr-fix-loops.json');
  const persisted = JSON.parse(await fs.readFile(file, 'utf8')); persisted.loops[0].worker = null;
  await fs.writeFile(file, JSON.stringify(persisted));
  const restarted = make(); await restarted.start();
  await expect(restarted.update(loop.id, { maxIterations: 3 })).rejects.toThrow();
  await expect(restarted.resume(loop.id)).rejects.toThrow();
  expect((await restarted.list())[0].status).toBe('error');
  expect(hostSent).toEqual([]); expect(sent).toEqual([]);
  restarted.stop();
});

test('stop keeps the receipt and stops the worker containers', async () => {
  const runtime = make(); const loop = await pending(runtime);
  const stopped = await runtime.stopLoop(loop.id);
  expect(stoppedWorkers).toEqual(['aabbccddeeff']);
  expect(stopped.pendingApproval).toEqual(loop.pendingApproval);
  runtime.stop();
});

test('a stopped publication releases its reservation after clearing its last retained receipt', async () => {
  let entered;
  let finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  const automation = createAutomationAdmission();
  const runtime = make({ automation, onPublish: async () => { entered(); await waiting; } });
  const loop = await pending(runtime);
  const publishing = runtime.approve(loop.id, loop.pendingApproval.id);
  await started;
  await runtime.stopLoop(loop.id);
  finish();
  await publishing;
  expect((await runtime.list())[0]).toMatchObject({ status: 'stopped', pendingApproval: null, review: null });
  expect(automation.owns(fixLoopOwner(loop.id))).toBe(false);
  expect(() => automation.claim('replacement', [sessionKey(input.sessionId)])).not.toThrow();
  await runtime.stop();
});

test('a stop during protected worker resume cannot reactivate the loop or leave its worker running', async () => {
  let entered;
  let finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  const runtime = make({ onResume: async () => { entered(); await waiting; } });
  const loop = await activate(runtime);
  await runtime.stopLoop(loop.id);
  const resuming = runtime.resume(loop.id);
  await started;
  await runtime.stopLoop(loop.id);
  finish();
  await expect(resuming).rejects.toThrow('stopped');
  expect((await runtime.list())[0].status).toBe('stopped');
  expect(stoppedWorkers).toHaveLength(3);
  expect(published).toEqual([]);
  expect(timers).toEqual([]);
  await runtime.stop();
});

test('stopping during approval preflight prevents the host publication', async () => {
  // Given
  let finishRead;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const response = new Promise((resolve) => { finishRead = resolve; });
  let hold = false;
  const runtime = make({ readFeedback: async () => { if (hold) { started(); return response; } return remote; } });
  const loop = await pending(runtime); hold = true;
  // When
  const approval = runtime.approve(loop.id, loop.pendingApproval.id);
  await reading; await runtime.stopLoop(loop.id); finishRead(remote);
  // Then
  await expect(approval).rejects.toThrow();
  expect(published).toEqual([]);
  expect((await runtime.list())[0].status).toBe('stopped');
  runtime.stop();
});

test('a malformed execution mode cannot silently select the ordinary host queue', async () => {
  const runtime = make();
  await expect(runtime.create({ ...input, config: { pushMode: 'unsupported' } })).rejects.toThrow();
  expect(hostSent).toEqual([]); expect(sent).toEqual([]);
  runtime.stop();
});

test('approval usage charges the worker while leaving host-session usage untouched', async () => {
  // Given
  let hostUsageReads = 0;
  const runtime = make({ readTokenSnapshot: async () => { hostUsageReads += 1; return 9000; } });
  await activate(runtime, { pushMode: 'approval', tokenBudget: 50 }); await tick(); usage = 25;
  // When
  await tick();
  // Then
  expect((await runtime.list())[0].tokensUsed).toBe(25); expect(hostUsageReads).toBe(0);
  runtime.stop();
});

test('a corrupt persisted receipt file is retained and blocks activation', async () => {
  const file = path.join(directory, 'pr-fix-loops.json'); await fs.writeFile(file, '{bad');
  const runtime = make();
  await expect(runtime.create(input)).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe('{bad'); expect(hostSent).toEqual([]);
  runtime.stop();
});

const addThread = () => {
  remote.threads = [{ id: 'PRRT_assigned', resolved: false, comments: [{ id: 11, body: 'Please fix', url: '', author: { login: 'reviewer', bot: false } }] }];
};

test('posts assigned replies and resolves fixed threads automatically only after exact approved publication', async () => {
  addThread(); const runtime = make(); const loop = await pending(runtime);
  expect(loop.review.state).toBe('awaitingPublication'); expect(reviewWrites).toEqual([]);
  await runtime.approve(loop.id, loop.pendingApproval.id);
  expect(published).toHaveLength(1); expect(reviewWrites).toEqual([]);
  remote.headSha = result;
  await tick();
  expect(reviewWrites.map(({ operation }) => operation.kind)).toEqual(['thread-reply', 'thread-resolve']);
  expect(reviewWrites.every(({ receipt }) => receipt.commit === result)).toBe(true);
  expect((await runtime.list())[0].review.state).toBe('complete');
  runtime.stop();
});

test('posts marked replies, then watches the ready PR without reacting to them', async () => {
  // Given
  addThread(); const runtime = make(); const loop = await pending(runtime);
  await runtime.approve(loop.id, loop.pendingApproval.id);
  remote.headSha = result; remote.ci.state = 'success';
  // When
  await tick();
  const reply = reviewWrites.find(({ operation }) => operation.kind === 'thread-reply').operation.body;
  remote.threads = [{ ...remote.threads[0], comments: [...remote.threads[0].comments,
    { id: 12, body: reply, url: '', createdAt: new Date().toISOString(), author: { login: 'user', bot: false } }] }];
  await tick();
  // Then
  expect(reply).toContain('Fixed in the approved commit.');
  expect(reply).toContain('Written by the OpenChamber agent');
  expect(reply).toContain('<!-- openchamber-agent:v1 -->');
  expect(sent).toHaveLength(1);
  expect((await runtime.list())[0]).toMatchObject({ status: 'watching', statusReason: 'waiting-review' });
  remote.threads = [{ ...remote.threads[0], resolved: true }];
  await tick();
  expect((await runtime.list())[0]).toMatchObject({ status: 'watching', statusReason: 'pr-ready', iterations: 0, totalIterations: 1 });
  expect(sent).toHaveLength(1);
  runtime.stop();
});

test('pending review writes recover on restart without another turn or publication', async () => {
  addThread(); const first = make(); const loop = await pending(first);
  await first.approve(loop.id, loop.pendingApproval.id); await first.stop(); timers = []; remote.headSha = result; remote.ci.state = 'success';
  const restarted = make(); await restarted.start(); await tick();
  expect(reviewWrites.map(({ operation }) => operation.kind)).toEqual(['thread-reply', 'thread-resolve']);
  expect(published).toHaveLength(1); expect(sent).toHaveLength(1); expect(hostSent).toEqual([]);
  restarted.stop();
});

test('an interrupted reply repeats only its exact durable key and cannot become ready on a green PR', async () => {
  addThread();
  const first = make({ applyReviewOperation: async (operation) => {
    reviewWrites.push(structuredClone(operation)); throw new Error('reply result lost');
  } });
  const loop = await pending(first); await first.approve(loop.id, loop.pendingApproval.id); await tick();
  expect((await first.list())[0].review.state).toBe('blocked');
  await first.stop(); timers = []; remote.headSha = result; remote.threads = []; remote.ci.state = 'success';
  const restarted = make({ applyReviewOperation: async (operation) => {
    reviewWrites.push(structuredClone(operation)); throw new Error('outcome unknown');
  } });
  await restarted.start(); await tick();
  expect(reviewWrites[1].operation.idempotencyKey).toBe(reviewWrites[0].operation.idempotencyKey);
  expect(reviewWrites[1].replayOnly).toBe(true);
  expect((await restarted.list())[0].status).not.toBe('ready');
  expect(sent).toHaveLength(1); expect(published).toHaveLength(1);
  restarted.stop();
});

test('independent GitHub write permission refusal is a visible blocker with no host fallback', async () => {
  addThread(); const runtime = make({ applyReviewOperation: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } });
  const loop = await pending(runtime); await runtime.approve(loop.id, loop.pendingApproval.id); await tick();
  const current = (await runtime.list())[0];
  expect(current.review.state).toBe('blocked'); expect(current.lastError).toContain('write permission');
  expect(current.review.completed).toBe(0); expect(hostSent).toEqual([]);
  runtime.stop();
});

test('a worker cannot add a reply target from another PR or iteration', async () => {
  addThread(); const runtime = make(); await activate(runtime); await tick();
  const turnId = /Use \{"turnId":"([^"]+)"/.exec(sent[0].item.text)[1];
  reviewReply = `\`\`\`openchamber-review-actions\n${JSON.stringify({ turnId,
    actions: [{ kind: 'thread', id: 'PRRT_other', body: 'Malicious', resolve: true }] })}\n\`\`\``;
  await tick();
  expect((await runtime.list())[0].pendingApproval).toBeNull(); expect(reviewWrites).toEqual([]); expect(published).toEqual([]);
  runtime.stop();
});

test.each(['receipt', 'review'])('duplicate activation refuses configuration changes during frozen %s work', async (phase) => {
  addThread(); const runtime = make(); const loop = await pending(runtime);
  if (phase === 'review') await runtime.approve(loop.id, loop.pendingApproval.id);
  const file = path.join(directory, 'pr-fix-loops.json');
  const before = await fs.readFile(file, 'utf8');
  await expect(runtime.create({ ...input, config: { pushMode: 'approval', maxIterations: 17, tokenBudget: 500 } })).rejects.toMatchObject({ statusCode: 409 });
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect((await runtime.list())[0].config.maxIterations).toBe(10);
  expect(sent).toHaveLength(1); expect(hostSent).toEqual([]);
  runtime.stop();
});

test('duplicate activation can update configuration before approval work is frozen', async () => {
  const runtime = make(); const loop = await activate(runtime);
  const updated = await runtime.create({ ...input, config: { pushMode: 'approval', maxIterations: 17 } });
  expect(updated.id).toBe(loop.id); expect(updated.config.maxIterations).toBe(17);
  expect(sent).toEqual([]); expect(hostSent).toEqual([]);
  runtime.stop();
});

test.each([
  ['closed before publication', 'closed', false], ['merged before publication', 'merged', false],
  ['closed during reconciliation', 'closed', true], ['merged during reconciliation', 'merged', true],
])('%s refuses approval and retains its receipt', async (_label, state, alreadyPublished) => {
  const runtime = make(); const loop = await pending(runtime);
  if (alreadyPublished) {
    failPublication = true;
    await expect(runtime.approve(loop.id, loop.pendingApproval.id)).rejects.toThrow();
    failPublication = false; remote.headSha = result;
  }
  remote.state = state;
  const file = path.join(directory, 'pr-fix-loops.json');
  const before = JSON.parse(await fs.readFile(file, 'utf8')).loops[0];
  const pushes = published.length;
  await expect(runtime.approve(loop.id, loop.pendingApproval.id)).rejects.toThrow('open');
  const after = JSON.parse(await fs.readFile(file, 'utf8')).loops[0];
  expect(after.pendingApproval).toEqual(before.pendingApproval);
  expect(after.internal.publication).toEqual(before.internal.publication);
  expect(after.internal.turnSnapshot).toEqual(before.internal.turnSnapshot);
  expect(after.internal.publicationState).toBe(before.internal.publicationState);
  expect(published).toHaveLength(pushes); expect(reviewWrites).toEqual([]);
  runtime.stop();
});

test('announces a receipt waiting for approval once, however often the loop is saved', async () => {
  const awaiting = [];
  const runtime = make({ notifyAwaitingApproval: async (loop) => { awaiting.push([loop.id, loop.status, loop.pendingApproval?.id]); } });
  await activate(runtime, { pushMode: 'approval', tokenBudget: 50 }); await tick(); usage = 50; await tick();
  const loop = (await runtime.list())[0];
  expect(loop.status).toBe('waitingForPush');
  await runtime.refresh(loop.id); await tick();
  expect(awaiting).toEqual([[loop.id, 'waitingForPush', loop.pendingApproval.id]]);
  runtime.stop();
});

test('an approval budget retains its exact receipt across restart and settles after publication', async () => {
  const notifications = [];
  const options = { notify: async (loop) => { notifications.push(loop.status); } };
  const first = make(options);
  await activate(first, { pushMode: 'approval', tokenBudget: 50 }); await tick(); usage = 50; await tick();
  const loop = (await first.list())[0];
  expect(loop).toMatchObject({ status: 'waitingForPush', tokensUsed: 50 });
  expect(loop.pendingApproval.commit).toBe(result); expect(notifications).toEqual([]);
  await first.refresh(loop.id); await tick();
  expect((await first.list())[0].pendingApproval).toEqual(loop.pendingApproval);
  await first.stop(); timers = [];
  const restarted = make(options); await restarted.start();
  expect((await restarted.list())[0].pendingApproval).toEqual(loop.pendingApproval);
  const approved = await restarted.approve(loop.id, loop.pendingApproval.id);
  expect(approved).toMatchObject({ status: 'budgetReached', pendingApproval: null, tokensUsed: 50 });
  expect(notifications).toEqual(['budgetReached']); expect(published).toHaveLength(1);
  await restarted.refresh(loop.id);
  expect(sent).toHaveLength(1); expect(hostSent).toEqual([]); expect(timers).toEqual([]);
  restarted.stop();
});

test('an approval budget lets pending review writes finish after restart before settling', async () => {
  addThread(); const notifications = [];
  const notify = async (loop) => { notifications.push(loop.status); };
  const first = make({ notify, applyReviewOperation: async (operation) => {
    reviewWrites.push(structuredClone(operation)); throw new Error('Durable reply acknowledgement lost');
  } });
  await activate(first, { pushMode: 'approval', tokenBudget: 50 }); await tick(); usage = 60; await tick();
  const loop = (await first.list())[0];
  expect(notifications).toEqual([]);
  const approved = await first.approve(loop.id, loop.pendingApproval.id);
  expect(approved).toMatchObject({ status: 'watching', review: { state: 'pending' }, tokensUsed: 60 });
  await tick();
  expect((await first.list())[0]).toMatchObject({ status: 'watching', review: { state: 'blocked' } });
  expect(notifications).toEqual([]); expect(sent).toHaveLength(1);
  await first.stop(); timers = [];
  remote.headSha = result; remote.ci.state = 'success'; remote.threads = [];
  const restarted = make({ notify }); await restarted.start(); await tick();
  const finished = (await restarted.list())[0];
  expect(finished).toMatchObject({ status: 'budgetReached', tokensUsed: 60, review: { state: 'complete', completed: 2 } });
  expect(reviewWrites[1].replayOnly).toBe(true);
  expect(reviewWrites[1].operation.idempotencyKey).toBe(reviewWrites[0].operation.idempotencyKey);
  expect(notifications).toEqual(['budgetReached']); expect(published).toHaveLength(1);
  expect(sent).toHaveLength(1); expect(hostSent).toEqual([]); expect(timers).toEqual([]);
  restarted.stop();
});

test('an interrupted export at the approval budget retains completed work for receipt capture after restart', async () => {
  const notifications = [];
  const options = { notify: async (loop) => { notifications.push(loop.status); } };
  const first = make(options);
  await activate(first, { pushMode: 'approval', tokenBudget: 50 }); await tick(); usage = 50; failExport = true;
  await tick();
  expect((await first.list())[0]).toMatchObject({ status: 'working', tokensUsed: 50, pendingApproval: null });
  expect(notifications).toEqual([]);
  await first.stop(); timers = []; failExport = false;
  const restarted = make(options); await restarted.start(); await tick();
  expect((await restarted.list())[0]).toMatchObject({ status: 'waitingForPush', tokensUsed: 50, pendingApproval: { commit: result } });
  expect(sent).toHaveLength(1); expect(hostSent).toEqual([]); expect(notifications).toEqual([]);
  restarted.stop();
});
