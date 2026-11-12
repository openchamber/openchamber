import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createFixLoopRuntime } from './runtime.js';
import { destinationOf } from './approval-contract.js';
import { CONTEXT, FEEDBACK, HEAD, RESULT, TARGET } from '../agent-server/fix-loop-test-fixture.js';

let dataDir;
let runtime;
let timers;
let worker;
let publication;
let enqueue;
let broadcast;
const input = { ...TARGET, directory: '/repo', sessionId: 'ses_host', accountId: 'account', readContext: CONTEXT,
  config: { pushMode: 'approval' }, snapshot: FEEDBACK };
beforeEach(async () => {
  dataDir = await fs.mkdtemp('/tmp/opencode/d2c-runtime-'); timers = [];
  worker = { prepare: vi.fn(async () => ({ id: crypto.randomUUID(), spaceId: 'aabbccddeeff', parentSessionId: 'ses_host', directory: '/repo',
    model: { providerID: 'openai', modelID: 'gpt-4.1' }, sessionId: null, spacePath: null })), validate: vi.fn(async () => {}),
    initialize: vi.fn(async (loop) => ({ ...loop.worker, sessionId: 'ses_worker', spacePath: '/spaces/aabbccddeeff/repo' })),
    working: vi.fn(async () => false), enqueue: vi.fn(async () => {}), stop: vi.fn(async () => {}), resume: vi.fn(async () => {}),
    export: vi.fn(async () => ({ result: RESULT })), usage: vi.fn(async () => 0) };
  publication = { validate: vi.fn(async () => {}), publish: vi.fn(async () => {}), capture: vi.fn(async (_loop, snapshot) => {
    const id = crypto.randomUUID();
    return { receipt: { id, localRef: `refs/heads/openchamber-approval/${id}`, commit: RESULT, repositoryId: 'repository',
      destination: destinationOf(snapshot), createdAt: 1, changedPaths: 1, changedBytes: 2 }, authority: { bindingRevision: 2 } };
  }) };
  enqueue = vi.fn(); broadcast = vi.fn();
});
afterEach(async () => { await runtime?.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
const make = (extra = {}) => (runtime = createFixLoopRuntime({ dataDir, approvalOnly: true,
  getOctokit: async (accountId) => ({ accountId }), readFeedback: async () => FEEDBACK, readFailedChecks: async () => [],
  workerRuntime: worker, publication, applyReviewOperation: async () => {}, enqueue, broadcast,
  setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
  clearTimer: (timer) => { timers = timers.filter((entry) => entry !== timer); }, log: { warn() {} }, ...extra }));
const tick = async () => { const timer = timers.shift(); if (!timer) throw new Error('missing tick'); await timer.fn(); };
const activate = async () => {
  const prepared = await runtime.prepareWorker({ sessionId: 'ses_host', directory: '/repo', model: { providerID: 'openai', modelID: 'gpt-4.1' } });
  return runtime.create({ ...input, workerId: prepared.id });
};
test('approval-only runtime refuses explicit and persisted-default auto activation without host work', async () => {
  make({ readDefaults: async () => ({ pushMode: 'auto' }) });
  await expect(runtime.create({ ...input, config: undefined })).rejects.toMatchObject({ statusCode: 409 });
  await expect(runtime.create({ ...input, config: { pushMode: 'auto' } })).rejects.toMatchObject({ statusCode: 409 });
  expect(await runtime.list()).toEqual([]); expect(timers).toEqual([]); expect(enqueue).not.toHaveBeenCalled();
  const loop = await activate(); expect(await runtime.list()).toHaveLength(1);
  expect((await runtime.create({ ...input, config: undefined })).id).toBe(loop.id);
  await expect(runtime.assertHostDispatch('ses_host', '/repo', { id: (await runtime.list())[0].id })).rejects.toThrow();
});
test.each([1, 2])('approval-only runtime leaves version %s auto state untouched and refuses start, resume and dispatch', async (version) => {
  const file = path.join(dataDir, 'pr-fix-loops.json');
  const original = JSON.stringify({ version, loops: [{ ...input, id: 'fixloop_auto', status: 'working', config: { pushMode: 'auto' }, internal: { seen: [] } }] });
  await fs.writeFile(file, original);
  make();
  await expect(runtime.start()).rejects.toThrow();
  await expect(runtime.resume('fixloop_auto')).rejects.toThrow();
  await expect(runtime.refresh('fixloop_auto')).rejects.toThrow();
  await expect(runtime.assertHostDispatch('ses_host', '/repo', { id: 'fixloop_auto' })).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe(original); expect(enqueue).not.toHaveBeenCalled(); expect(timers).toEqual([]);
  expect(runtime.ownsIdentity('untrusted-id')).toBe(true);
});
test('front-door approval survives shutdown and restart with receipt, local identity and exact account scope', async () => {
  const readFeedback = vi.fn(async () => FEEDBACK); make({ readFeedback });
  const loop = await activate(); await tick(); await tick();
  const pending = (await runtime.list())[0].pendingApproval;
  expect(pending.destination.expectedHead).toBe(HEAD); expect(enqueue).not.toHaveBeenCalled();
  expect(runtime.ownsIdentity(loop.id)).toBe(true); expect(runtime.ownsIdentity(loop.worker.id)).toBe(true);
  expect(runtime.ownsIdentity(pending.id)).toBe(true); expect(runtime.ownsIdentity('fixloop_agent')).toBe(false);
  await runtime.stop(); expect(timers).toEqual([]);
  make({ readFeedback }); await runtime.start();
  expect((await runtime.list())[0].pendingApproval).toEqual(pending);
  await runtime.approve(loop.id, pending.id);
  expect(publication.publish.mock.calls[0][1].receipt).toEqual(pending);
  expect(readFeedback.mock.calls.every(([read]) => read.octokit.accountId === 'account' && read.directory === '/repo')).toBe(true);
  expect(worker.enqueue).toHaveBeenCalledOnce();
});
test('stop during front-door worker resume persists stop and prevents delayed activation', async () => {
  let entered; let finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  worker.resume.mockImplementation(async () => { entered(); await waiting; });
  make(); const loop = await activate(); await runtime.stopLoop(loop.id);
  const resuming = runtime.resume(loop.id); await started;
  await runtime.stopLoop(loop.id); finish(); await expect(resuming).rejects.toThrow('stopped');
  expect((await runtime.list())[0].status).toBe('stopped'); expect(worker.stop).toHaveBeenCalledTimes(3);
  expect(timers).toEqual([]);
});
test('front-door host-session deletion stops its local protected worker and retains durable state', async () => {
  make(); const loop = await activate();
  let stopped;
  const completion = new Promise((resolve) => { stopped = resolve; });
  worker.stop.mockImplementation(async () => { stopped(); });
  runtime.processPayload({ type: 'session.deleted', properties: { info: { id: 'ses_host' } } });
  await completion;
  expect(worker.stop).toHaveBeenCalledOnce();
  await runtime.flush();
  expect((await runtime.list())[0]).toMatchObject({ id: loop.id, status: 'stopped' });
  expect(JSON.parse(await fs.readFile(path.join(dataDir, 'pr-fix-loops.json'), 'utf8')).loops[0].status).toBe('stopped');
});
test('delegated feedback failure preserves known CI and backs off deterministically without host queue fallback', async () => {
  const readFeedback = vi.fn(async () => ({ ...FEEDBACK, ci: { ...FEEDBACK.ci, state: 'pending' } }));
  make({ readFeedback, now: () => 1000 }); await activate(); await tick();
  const before = (await runtime.list())[0].ci;
  readFeedback.mockRejectedValue(Object.assign(new Error('agent_unreachable'), { code: 'agent_unreachable' }));
  await tick(); expect((await runtime.list())[0].ci).toEqual(before); expect(timers[0].ms).toBe(60_000);
  await tick(); expect((await runtime.list())[0].ci).toEqual(before); expect(timers[0].ms).toBe(120_000);
  expect(worker.enqueue).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
});
