import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import express from 'express';
import { createAutoReviewRuntime, registerAutoReviewRoutes } from '../auto-review/runtime.js';
import { createMessageQueueRuntime, registerMessageQueueRoutes } from '../message-queue/runtime.js';
import { createFixLoopRuntime, registerFixLoopRoutes } from '../pr-fix-loop/runtime.js';
import { createPrWatchRuntime, registerPrWatchRoutes, parsePullRequestUrl } from '../pr-watch/runtime.js';
import { createTrackedItemsService } from '../tracked-items/service.js';
import { createAutoResumeRuntime } from '../session-interruption/auto-resume.js';
import { createAutomationAdmission, sessionKey } from './runtime.js';

const listen = async (app) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};
const until = async (check) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('public runtime scenario did not settle');
};

test('public HTTP modules preserve queued review work and defer a real tracked-item wake until its PR writer stops', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-public-'));
  const writes = [];
  const active = { ses_original: { type: 'running' }, ses_review: { type: 'running' } };
  const opencode = express();
  opencode.use(express.json());
  opencode.get('/api/session/active', (_req, res) => res.json({ data: active }));
  opencode.get('/api/session', (_req, res) => res.json({ data: [], cursor: {} }));
  opencode.get('/api/session/:id/message', (_req, res) => res.json({ data: [], cursor: {} }));
  opencode.get('/api/session/:id', (req, res) => res.json({ id: req.params.id }));
  opencode.post('/api/session/:id/:action', (req, res) => {
    writes.push({ sessionID: req.params.id, action: req.params.action, body: req.body });
    res.json({ data: { id: req.body.id ?? 'msg_fixture12345' } });
  });
  const upstream = await listen(opencode);
  const hub = { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} };
  let auto;
  let fix;
  let queue;
  let watch;
  const admission = createAutomationAdmission({
    restore: async () => {
      await Promise.all([auto.load(), fix.load()]);
      return [...auto.ownershipClaims(), ...fix.ownershipClaims()];
    },
    onRelease: (keys) => {
      for (const key of keys) if (key.startsWith('session:')) queue.release(key.slice(8));
      watch.release(keys);
    },
  });
  const common = { dataDir, automation: admission, globalEventHub: hub,
    buildOpenCodeUrl: (route) => `${upstream.base}${route}`, getOpenCodeAuthHeaders: () => ({}) };
  auto = createAutoReviewRuntime({ ...common, quietMs: 0 });
  fix = createFixLoopRuntime({ ...common, hasQueuedItem: () => false, setTimer: () => null, clearTimer() {},
    getOctokit: async () => ({}), readFeedback: async () => ({ state: 'open', headSha: 'fixture', branch: 'fix',
      ci: { state: 'success', total: 1, contexts: [] }, threads: [], reviews: [], comments: [] }) });
  queue = createMessageQueueRuntime({ ...common, dispatchQuietMs: 0,
    isDeliveryHeld: (id) => auto.holdsDelivery(id), assertFixLoopHostDispatch: (...args) => fix.assertHostDispatch(...args) });
  watch = createPrWatchRuntime({ ...common, quietMs: 0 });
  let checks = 'pending';
  let summaryReads = 0;
  const readers = { sourceControl: async ({ pulls }) => {
    summaryReads += 1;
    return { status: 'ok', pulls: pulls.map((ref) => ({ ...ref, state: 'open', title: 'Fixture PR', headSha: 'fixture',
      checks: { state: checks }, mergeableState: 'clean', activity: 1 })) };
  } };
  const tracked = createTrackedItemsService({ readers, send: () => true, isConnectionOpen: () => false });
  watch.attach({ trackedItems: tracked, readers });
  await fix.attachTracking(tracked);
  auto.start(); queue.start(); watch.start(hub);
  const app = express(); app.use(express.json());
  registerAutoReviewRoutes(app, auto);
  registerMessageQueueRoutes(app, queue);
  registerPrWatchRoutes(app, watch);
  registerFixLoopRoutes(app, { runtime: fix, createWithContext: (req) => fix.create({ ...req.body, directory: '/repo', accountId: 'fixture' }) });
  const api = await listen(app);
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`${api.base}${route}`, { method, headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const run = { originalSessionID: 'ses_original', reviewSessionID: 'ses_review', directory: '/repo',
      handoff: { text: 'handoff fixture', instructions: '' },
      prompts: { reviewStart: 'Review fixture', reviewRules: '', feedbackToImplementer: '{{review_feedback}}', responseToReviewer: '{{implementation_response}}' } };
    assert.equal((await request('/api/auto-review/runs', 'POST', run)).status, 200);
    assert.equal((await request('/api/auto-review/runs', 'POST', { ...run, originalSessionID: 'ses_review', reviewSessionID: 'ses_another' })).status, 409);
    await request('/api/message-queue/sessions/ses_review/items', 'POST', { directory: '/repo',
      item: { content: 'queued user follow-up', sendConfig: { providerID: 'fixture', modelID: 'fixture' } } });
    delete active.ses_review;
    queue.release('ses_review');
    await delay(30);
    assert.equal(writes.length, 0);
    const created = await request('/api/source-control/github/pr/fix-loops', 'POST', { sessionId: 'ses_writer', owner: 'acme', repo: 'app', number: 7 });
    assert.equal(created.status, 200);
    await watch.watch({ sessionID: 'ses_waiter', directory: '/repo', url: 'https://github.com/acme/app/pull/7' });
    checks = 'success';
    tracked.refresh([parsePullRequestUrl('https://github.com/acme/app/pull/7')]);
    await until(() => watch.snapshot().watches[0]?.status === 'waking');
    await delay(30);
    assert.equal(writes.length, 0);
    await request(`/api/source-control/github/pr/fix-loops/${created.body.loop.id}/stop`, 'POST');
    await until(() => writes.some((entry) => entry.sessionID === 'ses_waiter'));
    assert.equal(writes[0].body.metadata.source, 'openchamber-pr-watch');
    assert.equal((await request('/api/pr-watch')).body.watches.length, 0);
    await request('/api/auto-review/runs/ses_original', 'DELETE');
    await until(() => writes.some((entry) => entry.sessionID === 'ses_review' && entry.action === 'prompt'));
    assert.equal((await request('/api/message-queue')).body.sessions.find((entry) => entry.sessionId === 'ses_review')?.items.length ?? 0, 0);
    assert.ok(summaryReads >= 2, 'positive control: real tracked-item provider reads ran');
    console.log(`Public-module proof: ${summaryReads} fixture summary reads; PR wake released once; reviewer follow-up dispatched only after Auto Review removal.`);
  } finally {
    tracked.dispose(); auto.stop(); queue.stop(); watch.stop(); await fix.stop();
    await Promise.all([auto.flush(), queue.flush(), watch.flush()]);
    await Promise.all([new Promise((resolve) => api.server.close(resolve)), new Promise((resolve) => upstream.server.close(resolve))]);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('priority restart resume retains a manual notice when persisted automation owns the session', async () => {
  const admission = createAutomationAdmission({ restore: async () => [{ owner: 'fixture-review', keys: [sessionKey('ses_priority')] }] });
  const at = Date.now();
  let metadata = { openchamber: { priority: { at }, interruption: { reason: 'opencode-restart', at, resume: null } } };
  let writes = 0;
  const runtime = createAutoResumeRuntime({
    updateMetadata: async (_id, decide) => {
      const patch = decide(metadata);
      if (patch) metadata.openchamber.interruption = { ...metadata.openchamber.interruption, ...patch.openchamber.interruption };
      return { changed: Boolean(patch) };
    },
    readMemory: () => null,
    sendPrompt: async () => {
      await admission.ready();
      const release = admission.trySend(null, [sessionKey('ses_priority')]);
      if (!release) throw new Error('automation owns session');
      try { writes += 1; } finally { release(); }
    },
  });
  assert.deepEqual(await runtime.resume([{ sessionId: 'ses_priority', directory: '/repo', at, priority: true, recorded: true }]), { ses_priority: 'manual' });
  assert.equal(writes, 0);
  assert.equal(metadata.openchamber.interruption.resume.state, 'manual');
  runtime.stop();
});
